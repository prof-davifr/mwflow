#!/usr/bin/env python3
"""Bancada simulada: um LiteVNA64 que não existe.

DECISÃO DE PROJETO. O simulador não é um gerador de dados; é uma **porta serial
falsa**. Ele recebe os mesmos bytes que o aparelho receberia, interpreta os
mesmos comandos e devolve registros de FIFO de 32 bytes de verdade. Com isso o
`LiteVNA` real roda inteiro por cima dele — codificação de comando, leitura em
blocos, `freqIndex`, ressincronismo. Um gerador de dados testaria só a física;
esta porta falsa testa o driver.

O que ele modela:

1. Um dispositivo sob teste trocável (`--dut`), incluindo o ressoador do sensor
   de etanol com f0 e Q tirados de `relatorios/s049/metrics.json`.
2. Uma caixa de erro sintética — diretividade, casamento de fonte, rastreio com
   atraso de cabo, isolamento e **casamento da porta 2**. Este último é o termo
   que o SOLT deste hardware não consegue corrigir; ele existe aqui para o
   marco 5 medir o erro residual em vez de supor que é zero.
3. Ruído no nível medido no artigo (rms ~1e-3 em |S21|) e deriva lenta de f0,
   para as telas de osciloscópio e espectrograma mostrarem algo plausível.
4. Injeção de falhas, para exercitar a escada de recuperação do driver.

REGRA DE SEGURANÇA. `info()["variante"]` devolve `"simulado"`. Esse rótulo
desce para toda linha do banco, todo CSV e todo Touchstone. Dado simulado tem
de ser incapaz de virar número de artigo por engano — a convenção deste
repositório é que todo número tem um script que o gera.

Uso:

    python3 -m mwflow.vna.simulador --demo
    python3 -m mwflow.vna.simulador --demo --dut carga
    python3 -m mwflow.vna.simulador --demo --turbo
"""

import sys
import time

import numpy as np

from mwflow.vna import protocolo as p

# Ressoador de referência. Os valores abaixo são genéricos de propósito: eles
# descrevem um ressoador plausível e servem para o estimador ser exercitado
# contra um caso de resposta conhecida, em qualquer máquina.
#
# ESTA BANCADA usa os valores MEDIDOS do sensor de etanol. Eles moram em
# `mwflow/vna/bancada.py`, que fica FORA do controle de versão: o sensor
# aguarda depósito no INPI, e este repositório é público. Sem aquele arquivo o
# simulador roda igual; só o ressoador simulado é outro.
F0_PADRAO = 1_500_000_000.0
Q_PADRAO = 10.0
IL_PADRAO = -30.0
RMS_PADRAO = 1.0e-3

try:
    from mwflow.vna import bancada
except ImportError:
    bancada = None

if bancada is not None:
    F0_PADRAO = bancada.F0_HZ
    Q_PADRAO = bancada.Q
    IL_PADRAO = bancada.IL_DB
    RMS_PADRAO = bancada.RMS

TAXA_PADRAO = 270.0     # valores por segundo, medidos na bancada
FWD_CONTAGENS = 1.0e6   # amplitude da referência em contagens do ADC


# --------------------------------------------------------------------- física
def _resposta_dut(f, dut, f0, q, il_db):
    """(S11, S21) verdadeiros do dispositivo sob teste."""
    if dut.startswith("atenuador"):
        db = float(dut.split(":")[1]) if ":" in dut else 10.0
        a = 10 ** (-db / 20.0)
        return (np.full(f.shape, 0.02 + 0j), np.full(f.shape, a + 0j))
    if dut == "aberto":
        # capacitância de franja de um aberto SMA típico: 50 fF
        w = 2 * np.pi * f
        z = 1j * w * 50e-15 * 50.0
        return (1 - z) / (1 + z), np.zeros_like(f, dtype=complex)
    if dut == "curto":
        w = 2 * np.pi * f
        z = 1j * w * 20e-12 / 50.0
        return (z - 1) / (z + 1), np.zeros_like(f, dtype=complex)
    if dut == "carga":
        return (np.full(f.shape, 0.003 + 0j),
                np.zeros(f.shape, dtype=complex))
    if dut == "thru":
        return (np.full(f.shape, 0.02 + 0j),
                np.exp(-2j * np.pi * f * 30e-12))
    if dut == "isolamento":
        return (np.full(f.shape, 0.003 + 0j),
                np.zeros(f.shape, dtype=complex))

    # ressoador: um polo, o MESMO modelo que ajuste.ajusta() ajusta
    fundo = 10 ** (-60 / 20.0)
    pico = 10 ** (il_db / 20.0)
    amp = pico - fundo
    lorentz = 1.0 / (1 + 2j * q * (f - f0) / f0)
    s21 = fundo + amp * lorentz
    # o S11 do ressoador afunda onde o S21 sobe, e é grande fora da ressonância
    s11 = 0.92 - 0.75 * lorentz
    return s11, s21


def _caixa_erro(f, semente=7, ideal=False):
    """Caixa de erro sintética. Devolve (e00, e11, e10e01, e30, e10e32, e22).

    Com `ideal=True` a caixa vira transparente: é o aparelho perfeito, útil
    para separar o erro do estimador do erro da calibração.
    """
    if ideal:
        z = np.zeros_like(f, dtype=complex)
        u = np.ones_like(f, dtype=complex)
        return z, z, u, z, u, z
    rng = np.random.default_rng(semente)
    tau = 1.0e-9                                 # atraso de cabo, 1 ns
    rot = np.exp(-2j * np.pi * f * tau)
    e00 = 0.02 * np.exp(2j * np.pi * f / 1.5e9) + 0.005   # diretividade
    e11 = 0.10 * rot                                       # casamento da fonte
    e10e01 = 0.95 * rot ** 2                               # rastreio de reflexão
    e30 = 10 ** (-85 / 20.0) * np.exp(1j * rng.uniform(0, 2 * np.pi))
    e10e32 = 0.90 * rot                                    # rastreio de transmissão
    e22 = 0.08 * rot                                       # casamento da porta 2
    return e00, e11, e10e01, e30, e10e32, e22


class SerialFalsa:
    """Imita o subconjunto de `serial.Serial` que o driver usa.

    Ela acumula os bytes escritos e interpreta comando a comando. Uma escrita
    parcial fica pendente, exatamente como no aparelho — é isso que torna o
    teste de ressincronismo honesto.
    """

    def __init__(self, dut="ressoador", turbo=False, semente=7,
                 f0=F0_PADRAO, q=Q_PADRAO, il_db=IL_PADRAO, deriva=True,
                 ideal=False, pad_db=0.0):
        self.ideal = bool(ideal)
        # Atenuador fixo na porta 2. Ele existe aqui porque é a única defesa
        # contra o termo `e22`, que sem chave de reversão é inobservável e
        # portanto incorrigível. Um pad de P dB reduz o efeito de `e22` em 2P
        # dB, ao custo de P dB de faixa dinâmica.
        self.pad_db = float(pad_db)
        self.is_open = True
        self.timeout = 2.0
        self.dut = dut
        self.turbo = bool(turbo)
        self.deriva = bool(deriva)
        self.f0 = float(f0)
        self.q = float(q)
        self.il_db = float(il_db)
        self.rng = np.random.default_rng(semente)
        self.semente = semente

        self._entrada = bytearray()   # bytes vindos do driver
        self._saida = bytearray()     # bytes a devolver
        self._reg = {p.REG_VARIANTE: 0x02, p.REG_PROTOCOLO: 1,
                     p.REG_HARDWARE: 2, p.REG_FW_MAIOR: 2, p.REG_FW_MENOR: 2}
        self._inicio = 0
        self._passo = 0
        self._pontos = 101
        self._vpf = 1
        self._idx = 0
        self._t0 = time.time()
        self._falha = None
        self._mudo_ate = 0.0

    # ------------------------------------------------------ injeção de falhas
    def injeta(self, tipo):
        """`desync` corta um registro, `mudo` cala 3 s, `lixo` emite ruído AT."""
        self._falha = tipo
        if tipo == "mudo":
            self._mudo_ate = time.time() + 3.0

    # ------------------------------------------------ interface do pyserial
    def write(self, dados):
        self._entrada += bytes(dados)
        self._processa()
        return len(dados)

    def flush(self):
        pass

    def reset_input_buffer(self):
        self._saida.clear()

    def read(self, n):
        if time.time() < self._mudo_ate:
            time.sleep(min(self.timeout, self._mudo_ate - time.time()))
            return b""
        d = bytes(self._saida[:n])
        del self._saida[:len(d)]
        return d

    def close(self):
        self.is_open = False

    # ---------------------------------------------------- máquina de comandos
    _TAM = {p.NOP: 1, p.INDICATE: 1, p.LE1: 2, p.LE2: 2, p.LE4: 2,
            p.LE_FIFO: 3, p.ESCREVE1: 3, p.ESCREVE2: 4, p.ESCREVE4: 6,
            p.ESCREVE8: 10, p.ESCREVE_FIFO: 3}

    def _processa(self):
        while self._entrada:
            op = self._entrada[0]
            tam = self._TAM.get(op)
            if tam is None:
                # opcode desconhecido: o aparelho real simplesmente ignora
                del self._entrada[0]
                continue
            if len(self._entrada) < tam:
                return                      # comando pela metade; espera o resto
            quadro = bytes(self._entrada[:tam])
            del self._entrada[:tam]
            self._executa(op, quadro)

    def _executa(self, op, q):
        if op == p.NOP:
            return
        if op == p.INDICATE:
            self._saida += bytes([p.RESPOSTA_INDICATE_V2])
            return
        if op in (p.LE1, p.LE2, p.LE4):
            n = {p.LE1: 1, p.LE2: 2, p.LE4: 4}[op]
            self._saida += int(self._reg.get(q[1], 0)).to_bytes(n, "little")
            return
        if op in (p.ESCREVE1, p.ESCREVE2, p.ESCREVE4, p.ESCREVE8):
            n = {p.ESCREVE1: 1, p.ESCREVE2: 2, p.ESCREVE4: 4, p.ESCREVE8: 8}[op]
            addr, val = q[1], int.from_bytes(q[2:2 + n], "little")
            if addr == p.REG_SWEEP_INICIO:
                self._inicio = val
            elif addr == p.REG_SWEEP_PASSO:
                self._passo = val
            elif addr == p.REG_SWEEP_PONTOS:
                self._pontos = max(1, val)
            elif addr == p.REG_VALORES_POR_F:
                self._vpf = max(1, val)
            elif addr == p.REG_FIFO:
                self._idx = 0               # limpar a FIFO reinicia o ciclo
            # os registradores de varredura leem zero neste firmware
            return
        if op == p.LE_FIFO:
            self._emite(q[2])
            return

    # ------------------------------------------------------------- geração
    def _emite(self, n):
        if self._falha == "lixo":
            self._saida += b"\r\nOK\r\nAT+CGMI\r\n"
            self._falha = None
        if not self.turbo:
            time.sleep(n / TAXA_PADRAO)

        idx = (self._idx + np.arange(n)) % self._pontos
        self._idx = int((self._idx + n) % self._pontos)
        f = self._inicio + self._passo * idx.astype(np.float64)

        f0 = self.f0
        if self.deriva:
            t = time.time() - self._t0
            f0 = f0 + 2.0e6 * np.sin(2 * np.pi * t / 180.0)

        s11, s21 = _resposta_dut(f, self.dut, f0, self.q, self.il_db)
        e00, e11, e10e01, e30, e10e32, e22 = _caixa_erro(f, self.semente,
                                                         self.ideal)

        # O atenuador da porta 2 fica ENTRE o dispositivo e a porta: ele
        # atenua o sinal uma vez e a onda refletida de volta outra vez, então
        # o descasamento visto pela porta 2 melhora pelo dobro do valor em dB.
        a_pad = 10 ** (-self.pad_db / 20.0)
        e22 = e22 * a_pad ** 2
        s21 = s21 * a_pad

        # o que o aparelho mede, e não o que o DUT é
        gm = e00 + e10e01 * s11 / (1 - e11 * s11)
        tm = e30 + e10e32 * s21 / ((1 - e11 * s11) * (1 - e22 * s11))

        fwd = np.full(n, FWD_CONTAGENS, dtype=complex)
        rev0 = gm * fwd
        rev1 = tm * fwd

        sig = RMS_PADRAO * FWD_CONTAGENS / np.sqrt(2)
        for v in (rev0, rev1):
            v += self.rng.normal(0, sig, n) + 1j * self.rng.normal(0, sig, n)
        fwd += (self.rng.normal(0, sig, n) + 1j * self.rng.normal(0, sig, n))

        r = np.zeros(n, dtype=p.DTYPE_FIFO)
        r["fwd_re"] = np.real(fwd).astype(np.int32)
        r["fwd_im"] = np.imag(fwd).astype(np.int32)
        r["rev0_re"] = np.real(rev0).astype(np.int32)
        r["rev0_im"] = np.imag(rev0).astype(np.int32)
        r["rev1_re"] = np.real(rev1).astype(np.int32)
        r["rev1_im"] = np.imag(rev1).astype(np.int32)
        r["idx"] = idx.astype(np.uint16)

        bruto = r.tobytes()
        if self._falha == "desync":
            bruto = bruto[:-7]              # registro cortado
            self._falha = None
        self._saida += bruto


def abre_simulado(**kw):
    """Devolve um `LiteVNA` com a porta falsa no lugar da serial."""
    from mwflow.vna.litevna import LiteVNA

    vna = LiteVNA(porta="simulado")
    vna.serial = SerialFalsa(**kw)
    vna.ressincroniza()
    vna.simulado = True
    return vna


# ------------------------------------------------------------------------ CLI
def _cli(argv):
    import argparse

    from mwflow.ajuste import ajusta

    ap = argparse.ArgumentParser(
        prog="mwflow.vna.simulador",
        description="Bancada simulada do LiteVNA64.")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--dut", default="ressoador",
                    help="ressoador|aberto|curto|carga|thru|isolamento|atenuador:10")
    ap.add_argument("--turbo", action="store_true", help="sem espera de tempo real")
    ap.add_argument("--pontos", type=int, default=401)
    ap.add_argument("--banda", nargs=2, type=float, default=[1.30e9, 2.00e9])
    a = ap.parse_args(argv)

    def uma(ideal, rotulo):
        vna = abre_simulado(dut=a.dut, turbo=a.turbo, deriva=False, ideal=ideal)
        vna.define_varredura(a.banda[0], a.banda[1], a.pontos)
        t0 = time.time()
        f, s11, s21 = vna.varre()
        dt = time.time() - t0
        vna.fecha()
        print()
        print("--- %s ---" % rotulo)
        print("varredura        : %d pontos em %.2f s (%.0f pontos/s), %d sem dado"
              % (a.pontos, dt, a.pontos / dt, int(np.isnan(s11).sum())))
        if a.dut != "ressoador":
            print("S11 médio        : %.2f dB"
                  % np.nanmean(20 * np.log10(np.abs(s11) + 1e-30)))
            print("S21 médio        : %.2f dB"
                  % np.nanmean(20 * np.log10(np.abs(s21) + 1e-30)))
            return
        r = ajusta(f, s21, tuple(a.banda))
        if r is None:
            print("ajuste 1 polo    : FALHOU")
            return
        print("ajuste 1 polo    : f0 = %.3f MHz | Q = %.3f | IL = %.2f dB | rms = %.2e"
              % (r["f0"] / 1e6, r["Q"], r["il_db"], r["rms"]))
        print("erro             : f0 %+.1f kHz | Q %+.1f %%"
              % ((r["f0"] - F0_PADRAO) / 1e3,
                 100 * (r["Q"] - Q_PADRAO) / Q_PADRAO))
        ib = int(np.nanargmax(np.abs(s21)))
        print("argmax (proibido): f0 = %.3f MHz  (erro %+.1f kHz)"
              % (f[ib] / 1e6, (f[ib] - F0_PADRAO) / 1e3))

    print("dispositivo      : simulado")
    print("DUT              :", a.dut)
    if a.dut == "ressoador":
        print("verdade          : f0 = %.3f MHz | Q = %.3f | IL = %.2f dB"
              % (F0_PADRAO / 1e6, Q_PADRAO, IL_PADRAO))

    uma(True, "caixa de erro IDEAL (aparelho perfeito)")
    uma(False, "caixa de erro REAL, SEM calibração")
    print()
    print("A diferença entre os dois blocos é o que a calibração SOLT remove.")
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
