"""Driver do LiteVNA64 sobre o protocolo binário NanoVNA-V2.

Base: `repos-independentes/ndtmwscanner/src/hardware/nanovna_driver.py`, com
dois defeitos corrigidos:

1. Aquele driver escrevia `points` no byte de contagem do comando LE_FIFO. Como
   a contagem tem um byte só, qualquer varredura acima de 255 pontos devolvia
   lixo ou travava. Aqui a leitura é em blocos.
2. `sweepData` era criado uma vez e não redimensionava quando `points` mudava.
   Aqui os vetores nascem a cada varredura.

Uso pela linha de comando:

    python3 -m mwflow.vna.litevna --info
    python3 -m mwflow.vna.litevna --varre 50e6 3e9 101
    python3 -m mwflow.vna.litevna --varre 1e9 2e9 1024
    python3 -m mwflow.vna.litevna --cw 1.5e9 --n 500
"""

import sys
import time

import numpy as np
import serial

from mwflow.caminhos import PORTA_PADRAO
from mwflow.vna import protocolo as p


class ErroVNA(Exception):
    """Falha de comunicação com o aparelho."""


class Abortado(Exception):
    """A aquisição foi interrompida a pedido, entre dois blocos da FIFO.

    Não é erro. Uma varredura abortada é descartada inteira: entregar meia
    varredura corromperia o ajuste em silêncio.
    """


class LiteVNA:
    """Dono exclusivo de uma porta serial do LiteVNA.

    Um único objeto deste tipo pode existir por porta. O motor de aquisição
    mantém esse objeto dentro de uma thread só, porque o pyserial bloqueia e o
    aparelho não aceita dois interlocutores.
    """

    nome = "LiteVNA64"

    def __init__(self, porta=None, bloco=p.BLOCO_PADRAO, tentativas=3):
        self.porta = porta or PORTA_PADRAO
        self.bloco = min(int(bloco), p.MAX_POR_LEITURA)
        self.tentativas = int(tentativas)
        self.serial = None
        # Evento opcional. Quando o motor o levanta, a leitura em curso para
        # no fim do bloco atual, e não no fim da varredura. Com 1024 pontos a
        # diferença é entre 0,1 s e 3,4 s de espera para trocar de banda.
        self.abortar = None
        self.simulado = False
        # estado da varredura configurada
        self.inicio_hz = 0.0
        self.passo_hz = 0.0
        self.pontos = 0
        self.valores_por_f = 1

    # ------------------------------------------------------------ ciclo de vida
    def abre(self):
        """Abre a porta com posse exclusiva e ressincroniza.

        `exclusive=True` pede TIOCEXCL ao núcleo: um segundo processo que tente
        abrir a mesma porta falha na hora, em vez de os dois disputarem a FIFO.

        A ressincronização na abertura não é zelo excessivo. O ModemManager
        está ativo nesta máquina e marca este aparelho como candidato
        (`ID_MM_CANDIDATE=1`); ele sonda portas CDC-ACM com comandos AT logo
        depois do plugue. Esses bytes caem no interpretador binário do LiteVNA
        e podem deixá-lo no meio de um comando.
        """
        if self.serial is None:
            try:
                self.serial = serial.Serial(self.porta, 115200, timeout=2.0,
                                            exclusive=True, rtscts=False,
                                            dsrdtr=False)
            except serial.SerialException as e:
                raise ErroVNA("não abriu %s: %s" % (self.porta, e)) from e
            self.ressincroniza()
        return self

    def fecha(self):
        if self.serial is not None:
            try:
                self.serial.close()
            finally:
                self.serial = None

    def __enter__(self):
        return self.abre()

    def __exit__(self, *exc):
        self.fecha()
        return False

    @property
    def aberto(self):
        return self.serial is not None and self.serial.is_open

    # ------------------------------------------------------------- baixo nível
    def ressincroniza(self):
        """Devolve o aparelho a um estado conhecido depois de um erro.

        Oito NOPs fecham qualquer comando pela metade; o descarte da entrada
        joga fora os bytes órfãos que ainda estavam a caminho.
        """
        s = self.serial
        s.reset_input_buffer()
        s.write(p.cmd_sincroniza())
        s.flush()
        time.sleep(0.05)
        s.reset_input_buffer()

    def _le_reg(self, addr, n):
        s = self.serial
        s.timeout = 1.0
        s.write(p.cmd_le(addr, n))
        d = s.read(n)
        if len(d) != n:
            raise ErroVNA("registrador 0x%02X: li %d de %d bytes"
                          % (addr, len(d), n))
        return int.from_bytes(d, "little")

    def confere(self):
        """Confirma que do outro lado há mesmo um aparelho da família V2."""
        s = self.serial
        s.timeout = 1.0
        s.reset_input_buffer()
        s.write(bytes([p.INDICATE]))
        r = s.read(1)
        if not r:
            raise ErroVNA("INDICATE sem resposta em %s — o aparelho fala o "
                          "protocolo de texto? (LiteVNA usa o binário V2)"
                          % self.porta)
        if r[0] != p.RESPOSTA_INDICATE_V2:
            raise ErroVNA("INDICATE devolveu 0x%02X, esperava 0x%02X"
                          % (r[0], p.RESPOSTA_INDICATE_V2))
        return True

    def info(self):
        """Identificação do aparelho."""
        self.abre()
        self.confere()
        return dict(
            porta=self.porta,
            variante=self._le_reg(p.REG_VARIANTE, 1),
            protocolo=self._le_reg(p.REG_PROTOCOLO, 1),
            hardware=self._le_reg(p.REG_HARDWARE, 1),
            firmware="%d.%d" % (self._le_reg(p.REG_FW_MAIOR, 1),
                                self._le_reg(p.REG_FW_MENOR, 1)),
        )

    # ------------------------------------------------------------ configuração
    def configura(self, inicio_hz, passo_hz, pontos, valores_por_f=1):
        """Escreve os registradores de varredura e limpa a FIFO.

        Ler de volta 0x00/0x10/0x20 devolve zero neste firmware. Não é falha:
        esses registradores só valem depois que o host escreve. Por isso o
        estado fica guardado aqui, não no aparelho.
        """
        self.abre()
        pontos = int(pontos)
        if not 1 <= pontos <= p.PONTOS_MAX:
            raise ValueError("pontos fora de 1..%d" % p.PONTOS_MAX)
        fim = inicio_hz + passo_hz * (pontos - 1)
        for f in (inicio_hz, fim):
            if not (p.F_MIN_HZ <= f <= p.F_MAX_HZ):
                raise ValueError("%.6g Hz fora da faixa do LiteVNA64 "
                                 "(%.0f Hz a %.3f GHz)"
                                 % (f, p.F_MIN_HZ, p.F_MAX_HZ / 1e9))

        self.inicio_hz = float(inicio_hz)
        self.passo_hz = float(passo_hz)
        self.pontos = pontos
        self.valores_por_f = int(valores_por_f)

        self.serial.write(p.cmd_varredura(inicio_hz, passo_hz, pontos,
                                          valores_por_f))
        self.serial.flush()
        # o aparelho reinicia a varredura; dá um tempo antes de limpar a FIFO
        time.sleep(0.05)
        self.limpa_fifo()
        return self

    def define_varredura(self, inicio_hz, fim_hz, pontos, valores_por_f=1):
        """Configura por início e fim, em vez de início e passo."""
        return self.configura(inicio_hz, p.passo_de(inicio_hz, fim_hz, pontos),
                              pontos, valores_por_f)

    def define_cw(self, f_hz, bloco=None, valores_por_f=1):
        """Modo de frequência fixa: passo nulo.

        Com o passo em zero todos os pontos caem na mesma frequência, e cada
        registro da FIFO vira uma amostra no tempo. É o que alimenta a tela do
        osciloscópio.
        """
        n = int(bloco or self.bloco)
        return self.configura(f_hz, 0, n, valores_por_f)

    def limpa_fifo(self):
        self.serial.reset_input_buffer()
        self.serial.write(p.cmd_limpa_fifo())
        self.serial.flush()

    def frequencias(self):
        return p.grade(self.inicio_hz, self.passo_hz, self.pontos)

    # --------------------------------------------------------------- aquisição
    def _timeout_de(self, n):
        """Folga generosa: 2 s de partida mais 20 ms por valor.

        Vinte milissegundos por valor é cerca de cinco vezes o tempo medido
        (270 valores por segundo). A folga cobre o primeiro bloco depois de uma
        reconfiguração, quando o aparelho ainda está reiniciando a varredura.
        """
        return 2.0 + 0.02 * n * max(1, self.valores_por_f)

    def _le_bloco(self, n):
        """Lê exatamente `n` valores da FIFO. Levanta ErroVNA se vier curto."""
        s = self.serial
        s.timeout = self._timeout_de(n)
        s.write(p.cmd_le_fifo(n))
        esperado = n * p.BYTES_POR_VALOR
        buf = s.read(esperado)
        if len(buf) != esperado:
            raise ErroVNA("FIFO curta: %d de %d bytes (%d valores)"
                          % (len(buf), esperado, n))
        return p.analisa_fifo(buf)

    def _le_n(self, total):
        """Lê `total` valores em blocos, respeitando o limite de 1 byte."""
        idxs, s11s, s21s = [], [], []
        restam = total
        while restam > 0:
            if self.abortar is not None and self.abortar.is_set():
                raise Abortado("leitura interrompida com %d de %d valores"
                               % (total - restam, total))
            n = min(self.bloco, restam)
            i, a, b = self._le_bloco(n)
            idxs.append(i)
            s11s.append(a)
            s21s.append(b)
            restam -= n
        return (np.concatenate(idxs), np.concatenate(s11s),
                np.concatenate(s21s))

    def _com_retentativa(self, funcao):
        """Executa uma leitura; em falha, ressincroniza e tenta de novo."""
        ultimo = None
        for tentativa in range(self.tentativas):
            try:
                return funcao()
            except ErroVNA as e:
                ultimo = e
                if tentativa + 1 < self.tentativas:
                    self.ressincroniza()
                    self.limpa_fifo()
                    time.sleep(0.1)
        raise ErroVNA("falhou após %d tentativas: %s" % (self.tentativas, ultimo))

    def varre(self):
        """Uma varredura completa. Devolve (f, s11, s21).

        A varredura do aparelho é cíclica. Ao ler `pontos` valores a partir de
        um lugar qualquer do ciclo, cada índice de frequência aparece uma vez —
        por isso o resultado é espalhado pelo `freqIndex`, e não pela ordem de
        chegada. Se algum índice faltar, o ponto sai NaN em vez de vir de outra
        varredura.

        Com `valores_por_f` acima de 1 é preciso ler `pontos * valores_por_f`
        registros e promediar por índice: a sonda mostrou que o aparelho emite
        um registro por valor e não promedia por dentro. Ler só `pontos`
        registros devolveria uma fração da varredura.
        """
        n = self.pontos
        v = max(1, self.valores_por_f)

        def leitura():
            self.limpa_fifo()
            return self._le_n(n * v)

        idx, s11, s21 = self._com_retentativa(leitura)

        val = (idx >= 0) & (idx < n)
        idx, s11, s21 = idx[val], s11[val], s21[val]

        conta = np.bincount(idx, minlength=n).astype(float)
        soma11 = (np.bincount(idx, weights=s11.real, minlength=n)
                  + 1j * np.bincount(idx, weights=s11.imag, minlength=n))
        soma21 = (np.bincount(idx, weights=s21.real, minlength=n)
                  + 1j * np.bincount(idx, weights=s21.imag, minlength=n))

        vazio = conta == 0
        conta[vazio] = np.nan          # 0/0 -> NaN, e não divisão por zero
        return self.frequencias(), soma11 / conta, soma21 / conta

    def varre_media(self, m=1):
        """Média de `m` varreduras. Devolve (f, s11, s21, desvio_s21).

        A média é feita aqui, no software, e não pelo registrador
        `valores_por_f` do aparelho: assim o número de varreduras somadas é
        conhecido e o desvio sai junto, o que a tela de calibração precisa.
        """
        m = max(1, int(m))
        f, a, b = self.varre()
        if m == 1:
            return f, a, b, np.zeros_like(np.abs(b))
        A = [a]
        B = [b]
        for _ in range(m - 1):
            _, x, y = self.varre()
            A.append(x)
            B.append(y)
        A = np.array(A)
        B = np.array(B)
        return (f, np.nanmean(A, axis=0), np.nanmean(B, axis=0),
                np.nanstd(np.abs(B), axis=0))

    def amostras_cw(self, n):
        """`n` amostras no tempo, na frequência fixa já configurada.

        Em modo CW o `freqIndex` não distingue nada — todos os pontos estão na
        mesma frequência. Aqui vale a ordem de chegada, não o índice.
        """
        # O passo tem de ser desprezível diante da frequência. Zero é o caso
        # normal; 1 Hz em 1,5 GHz é a alternativa de micro-varredura, que
        # existe caso algum firmware recuse passo nulo.
        largura = abs(self.passo_hz) * max(1, self.pontos - 1)
        if largura > 1e-6 * max(self.inicio_hz, 1.0):
            raise ErroVNA("amostras_cw exige frequência fixa: a grade atual "
                          "cobre %.3f Hz. Chame define_cw antes." % largura)
        _, s11, s21 = self._com_retentativa(lambda: self._le_n(int(n)))
        return s11, s21


# ------------------------------------------------------------------------ CLI
def _fmt_db(z):
    m = np.abs(z)
    with np.errstate(divide="ignore", invalid="ignore"):
        return 20 * np.log10(m)


def _cli(argv):
    import argparse

    ap = argparse.ArgumentParser(
        prog="mwflow.vna.litevna",
        description="Driver de linha de comando do LiteVNA64.")
    ap.add_argument("--porta", default=None, help="porta serial")
    ap.add_argument("--info", action="store_true", help="identificação")
    ap.add_argument("--varre", nargs=3, metavar=("INICIO", "FIM", "PONTOS"),
                    help="uma varredura, em Hz")
    ap.add_argument("--cw", metavar="FREQ", type=float,
                    help="modo de frequência fixa, em Hz")
    ap.add_argument("--n", type=int, default=500,
                    help="amostras no modo CW (padrão 500)")
    ap.add_argument("--media", type=int, default=1,
                    help="varreduras a promediar (padrão 1)")
    a = ap.parse_args(argv)

    vna = LiteVNA(a.porta)
    try:
        if a.info or not (a.varre or a.cw):
            i = vna.info()
            print("porta            :", i["porta"])
            print("deviceVariant    : 0x%02X %s"
                  % (i["variante"],
                     "(NanoVNA-V2 / LiteVNA)" if i["variante"] == p.VARIANTE_V2
                     else "(variante desconhecida)"))
            print("protocolVersion  :", i["protocolo"])
            print("hardwareRevision :", i["hardware"])
            print("firmware         :", i["firmware"])

        if a.varre:
            ini, fim, pts = float(a.varre[0]), float(a.varre[1]), int(a.varre[2])
            vna.define_varredura(ini, fim, pts)
            t0 = time.time()
            f, s11, s21, dp = vna.varre_media(a.media)
            dt = time.time() - t0
            faltam = int(np.isnan(s11).sum())
            print()
            print("varredura: %.3f a %.3f MHz, %d pontos, %d média(s), %.2f s "
                  "(%.0f pontos/s)"
                  % (ini / 1e6, fim / 1e6, pts, a.media, dt,
                     pts * a.media / dt))
            print("pontos sem dado: %d" % faltam)
            print()
            print("  freq (MHz)   S11 (dB)   S21 (dB)")
            passo = max(1, pts // 6)
            for k in range(0, pts, passo):
                print("  %10.3f   %8.2f   %8.2f"
                      % (f[k] / 1e6, _fmt_db(s11[k]), _fmt_db(s21[k])))

        if a.cw:
            vna.define_cw(a.cw)
            t0 = time.time()
            s11, s21 = vna.amostras_cw(a.n)
            dt = time.time() - t0
            d11, d21 = _fmt_db(s11), _fmt_db(s21)
            print()
            print("CW em %.6f MHz: %d amostras em %.2f s (%.0f amostras/s)"
                  % (a.cw / 1e6, a.n, dt, a.n / dt))
            print("S11: %.3f dB  desvio %.4f dB" % (np.nanmean(d11),
                                                    np.nanstd(d11)))
            print("S21: %.3f dB  desvio %.4f dB" % (np.nanmean(d21),
                                                    np.nanstd(d21)))
    except ErroVNA as e:
        print("ERRO:", e, file=sys.stderr)
        return 1
    finally:
        vna.fecha()
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
