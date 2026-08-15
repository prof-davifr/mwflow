#!/usr/bin/env python3
"""Motor de aquisição: uma thread dona da serial, muitos clientes no asyncio.

DIVISÃO. Uma thread do sistema operacional é dona da porta serial e roda um
laço bloqueante. O laço do asyncio é dono dos sockets e nunca bloqueia. Entre
os dois há exatamente dois canais, cada um de mão única.

Por que uma thread e não asyncio na serial: a leitura da FIFO é
pedido/resposta com bloqueio do lado do aparelho — `LE_FIFO` só responde quando
os valores existem. Isso se escreve naturalmente como código bloqueante, e o
`pyserial-asyncio` nem está instalado nesta máquina.

CANAL THREAD -> ASYNCIO: `loop.call_soon_threadsafe`. Não
`run_coroutine_threadsafe`: aquele cria um Future por item, e se alguém um dia
chamar `.result()` a thread de aquisição trava esperando o laço de eventos —
justamente o impasse que se quer evitar.

CANAL ASYNCIO -> THREAD: uma `queue.Queue` de comandos. Comandos são raros e
minúsculos.

INVARIANTES (quebrar qualquer uma destas é um defeito):

1. A thread de aquisição só chama `call_soon_threadsafe` do asyncio.
2. A thread de aquisição nunca bloqueia numa fila sem prazo.
3. O laço de eventos nunca toca no objeto do driver.
4. Toda leitura da serial tem prazo.
5. Comando de reconfiguração só é consumido entre aquisições completas.
"""

import asyncio
import json
import math
import queue
import threading
import time

import numpy as np

from mwflow import observaveis as ob
from mwflow.vna import protocolo as p
from mwflow.vna.litevna import Abortado, ErroVNA, LiteVNA

# Tópicos que nunca podem perder mensagem: são controle ou são a ciência.
NUNCA_DESCARTA = ("estado", "erro", "escalar", "sessao", "ponto", "captura",
                  "mensagem", "curva", "cal")

# Tópicos de fluxo contínuo: quando a fila do cliente enche, o quadro velho
# é jogado fora e o novo entra. Um traço atrasado não vale nada.
CONFLATA = ("varredura", "amostras_cw", "linha_espectro")


class Assinante:
    """Caixa de saída de um cliente. Um navegador lento só atrapalha a si.

    Duas políticas convivem aqui:

    - Tópicos de fluxo (`CONFLATA`) guardam só o último quadro. Se o cliente
      não consumiu o anterior, ele some e a perda é contada. Um traço atrasado
      não vale nada, e mostrar um traço velho é pior do que pular um quadro.
    - Tópicos de controle e de ciência (`NUNCA_DESCARTA`) entram numa fila. Se
      essa fila encher, algo está muito errado, e a perda aparece no estado.
    """

    LIMITE_CONFIAVEL = 4096

    def __init__(self, topicos):
        import collections
        self.topicos = set(topicos)
        self.confiaveis = collections.deque(maxlen=self.LIMITE_CONFIAVEL)
        self.ultimos = {}
        self.quedas = {}
        self.evento = asyncio.Event()
        self.vivo = True

    def entrega(self, msg):
        t = msg.get("tipo")
        if t not in self.topicos:
            return
        if t in CONFLATA:
            if t in self.ultimos:
                self.quedas[t] = self.quedas.get(t, 0) + 1
            self.ultimos[t] = msg
        else:
            if len(self.confiaveis) == self.LIMITE_CONFIAVEL:
                self.quedas[t] = self.quedas.get(t, 0) + 1
            self.confiaveis.append(msg)
        self.evento.set()

    async def proximo(self):
        """Espera e devolve o lote pendente: controle primeiro, fluxo depois."""
        await self.evento.wait()
        self.evento.clear()
        lote = list(self.confiaveis)
        self.confiaveis.clear()
        lote.extend(self.ultimos.values())
        self.ultimos.clear()
        return lote

    def assina(self, topicos):
        self.topicos = set(topicos)


class BaseTempo:
    """Reconstrói o instante de cada amostra em modo de frequência fixa.

    O aparelho entrega amostras a um ritmo constante, mas o USB entrega os
    lotes com tremor. Se o eixo do tempo usar o instante de chegada, o
    osciloscópio mostra ±10 ms de ruído que não existe. Então ajusta-se
    `t = a·n + b` por mínimos quadrados sobre os últimos lotes, e usa-se a reta.
    """

    def __init__(self, janela=40):
        self.janela = janela
        self.pontos = []
        self.a = 1.0 / 270.0
        self.b = 0.0

    def zera(self):
        self.pontos.clear()

    def registra(self, n_acumulado, t_chegada):
        self.pontos.append((n_acumulado, t_chegada))
        if len(self.pontos) > self.janela:
            del self.pontos[0]
        if len(self.pontos) >= 3:
            x = np.array([q[0] for q in self.pontos], float)
            y = np.array([q[1] for q in self.pontos], float)
            a, b = np.polyfit(x, y, 1)
            if a > 0:
                self.a, self.b = float(a), float(b)
        elif self.pontos:
            self.b = t_chegada - self.a * n_acumulado

    @property
    def taxa(self):
        return 1.0 / self.a if self.a > 0 else float("nan")

    def instantes(self, n0, n):
        return self.a * (n0 + np.arange(n)) + self.b


class Motor:
    """Aquisição contínua com reconfiguração segura."""

    def __init__(self, dispositivo=None, simulado=False, **kw_sim):
        if dispositivo is not None:
            self.vna = dispositivo
        elif simulado:
            from mwflow.vna.simulador import abre_simulado
            self.vna = abre_simulado(**kw_sim)
        else:
            self.vna = LiteVNA()
        self.simulado = bool(getattr(self.vna, "simulado", False))

        self._cmds = queue.Queue(maxsize=64)
        self._parar = threading.Event()
        self._abortar = threading.Event()
        self.vna.abortar = self._abortar
        self._thread = None
        self._loop = None
        self._assinantes = []
        self._trava = threading.Lock()

        # configuração corrente
        self.modo = "parado"
        self.f_inicio = 50e6
        self.f_fim = 3e9
        self.pontos = 401
        self.vpf = 1
        self.medias = 1
        self.f_cw = 1.5e9
        self.bloco_cw = 64
        self.geracao = 0

        # observável derivado
        self.param = "s21"
        self.banda = (1.30e9, 2.00e9)
        self.portoes = ob.Portoes()

        # estado observado
        self.identidade = {}
        self.seq = 0
        self.taxa_pontos = float("nan")
        self.taxa_varreduras = float("nan")
        self.ultimo_erro = None
        self.base = BaseTempo()
        self._n_cw = 0
        self.correcao = None      # preenchida pelo marco 5 (SOLT)

        # gravação e captura
        self.sessao = None
        self.gravando = False
        self._captura = None
        self._ultima = None       # (f, s11, s21) da varredura mais recente

        # calibração
        self.cal_medidas = {}     # padrão -> (f, s11, s21)
        self._cal_pedido = None
        self.cal_nome = None
        self.cal_modo = "inicial"
        self._cal_ini = None
        self._cal_fim = None
        self._cal_t0 = None
        self._cal_t1 = None
        self._termos_grade = None  # cache: termos já interpolados para a grade

    # ------------------------------------------------------------ ciclo de vida
    def inicia(self, loop=None):
        self._loop = loop or asyncio.get_event_loop()
        self._thread = threading.Thread(target=self._laco, name="aquisicao",
                                        daemon=False)
        self._thread.start()
        return self

    def encerra(self, prazo=5.0):
        self._parar.set()
        self._abortar.set()
        if self._thread:
            self._thread.join(prazo)
        try:
            self.vna.fecha()
        except Exception:
            pass

    # ------------------------------------------------------------- assinatura
    def assina(self, topicos):
        a = Assinante(topicos)
        with self._trava:
            self._assinantes.append(a)
        return a

    def desassina(self, a):
        a.vivo = False
        with self._trava:
            if a in self._assinantes:
                self._assinantes.remove(a)

    def _publica(self, msg):
        """Chamado NA THREAD de aquisição. Só agenda; não bloqueia."""
        if self._loop is None or self._loop.is_closed():
            return
        try:
            self._loop.call_soon_threadsafe(self._entrega, msg)
        except RuntimeError:
            pass                      # laço encerrando; nada a fazer

    def _entrega(self, msg):
        """Chamado NO LAÇO de eventos."""
        with self._trava:
            alvos = list(self._assinantes)
        for a in alvos:
            if a.vivo:
                a.entrega(msg)

    # ----------------------------------------------------------------- comandos
    def comanda(self, cmd):
        """Chamado do asyncio. Nunca bloqueia o laço de eventos."""
        try:
            self._cmds.put_nowait(cmd)
        except queue.Full:
            self._publica(dict(tipo="erro", nivel="erro", codigo="fila_cheia",
                               msg="fila de comandos cheia; comando ignorado"))
            return False
        # Trocar de banda ou de modo aborta a varredura em curso; os demais
        # comandos esperam ela terminar.
        if cmd.get("t") in ("configurar", "modo", "parar"):
            self._abortar.set()
        return True

    def _aplica_comandos(self):
        """Consome a fila. Só é chamado ENTRE aquisições completas."""
        mudou = False
        while True:
            try:
                c = self._cmds.get_nowait()
            except queue.Empty:
                break
            t = c.get("t")
            if t == "configurar":
                self.f_inicio = float(c.get("f_inicio_hz", self.f_inicio))
                self.f_fim = float(c.get("f_fim_hz", self.f_fim))
                self.pontos = int(c.get("n_pontos", self.pontos))
                self.vpf = max(1, int(c.get("vpf", self.vpf)))
                self.medias = max(1, int(c.get("medias", self.medias)))
                mudou = True
            elif t == "modo":
                self.modo = c.get("modo", self.modo)
                if c.get("f_cw_hz"):
                    self.f_cw = float(c["f_cw_hz"])
                if c.get("banda_hz"):
                    self.banda = tuple(float(x) for x in c["banda_hz"])
                mudou = True
            elif t == "iniciar":
                if self.modo == "parado":
                    self.modo = "varredura"
                mudou = True
            elif t == "parar":
                self.modo = "parado"
                mudou = True
            elif t == "observavel":
                self.param = c.get("param", self.param)
                if c.get("banda_hz"):
                    self.banda = tuple(float(x) for x in c["banda_hz"])
                self.portoes.reinicia()
            elif t == "portoes":
                for k in ("rms_max", "q_min", "q_max", "salto_max_hz",
                          "banda_adaptativa", "k_banda"):
                    if k in c:
                        setattr(self.portoes, k, c[k])
                self.portoes.reinicia()
            elif t == "gravar":
                self.gravando = bool(c.get("ligado", True))
            elif t == "capturar":
                self._inicia_captura(c)
            elif t == "cancelar_captura":
                self._captura = None
            elif t == "salvar_varredura":
                self._salva_ultima(c)
            elif t == "evento":
                if self.sessao:
                    self.sessao.grava_evento("info", "operador",
                                             c.get("rotulo", ""))
            elif t == "cal_medir":
                self._cal_pedido = dict(padrao=c.get("padrao"),
                                        n=max(1, int(c.get("n_medias", 16))))
                self._publica(dict(tipo="cal", estado="medindo",
                                   padrao=self._cal_pedido["padrao"]))
            elif t == "cal_esquecer":
                self.cal_medidas.pop(c.get("padrao"), None)
                self._publica(dict(tipo="cal", estado="medidas",
                                   padroes=sorted(self.cal_medidas)))
            elif t == "sim_dut":
                # Só existe na bancada simulada: troca o dispositivo sob teste
                # sem ninguém encostar num conector. É o que permite exercitar
                # a calibração inteira sem hardware.
                if self.simulado:
                    self.vna.serial.dut = c.get("dut", "ressoador")
                    self._publica(dict(tipo="mensagem",
                                       msg="dispositivo simulado: %s"
                                           % self.vna.serial.dut))
        return mudou

    # ---------------------------------------------------------- calibração
    def _mede_padrao(self, f, s11, s21):
        """Guarda a medida de um padrão. Chamado dentro do laço de aquisição."""
        p = self._cal_pedido
        if p is None:
            return
        acc = p.setdefault("acc", [])
        acc.append((np.asarray(s11), np.asarray(s21)))
        self._publica(dict(tipo="cal", estado="andando", padrao=p["padrao"],
                           faltam=p["n"] - len(acc)))
        if len(acc) < p["n"]:
            return
        a = np.nanmean(np.array([x[0] for x in acc]), axis=0)
        b = np.nanmean(np.array([x[1] for x in acc]), axis=0)
        self.cal_medidas[p["padrao"]] = (np.array(f), a, b)
        self._cal_pedido = None
        self._publica(dict(tipo="cal", estado="medido", padrao=p["padrao"],
                           padroes=sorted(self.cal_medidas),
                           n_medias=p["n"]))

    def aplica_correcao(self, ini=None, fim=None, modo="inicial"):
        """Monta a função de correção a partir dos conjuntos escolhidos.

        A correção é aplicada NA LEITURA. O que vai para o disco é sempre o
        dado bruto, então trocar de modo depois nunca destrói medida.
        """
        from mwflow import solt

        self._cal_ini = self._cal_fim = None
        self._termos_grade = None
        if ini is None:
            self.correcao = None
            self.cal_nome = None
            return dict(estado="bruto")

        t_ini, m_ini = solt.carrega(ini)
        self._cal_ini = t_ini
        self._cal_t0 = time.time()
        aviso = None
        if fim and modo != "inicial":
            t_fim, m_fim = solt.carrega(fim)
            self._cal_fim = t_fim
            self._cal_t1 = time.time() + 1.0
            d = solt.distancia(t_ini, t_fim)
            pior = max(d.values()) if d else -99
            if pior > -20:
                aviso = ("os dois conjuntos diferem em %.1f dB. A interpolação "
                         "no tempo supõe deriva lenta; uma diferença desse "
                         "tamanho costuma ser cabo mexido. Prefira o modo "
                         "'inicial' e marque a sessão como suspeita." % pior)
        self.cal_nome = ini
        self.cal_modo = modo

        def correcao(f, s11, s21, t):
            termos = self._termos_para(f, t)
            if termos is None:
                return s11, s21
            return solt.corrige(termos, s11, s21)

        self.correcao = correcao
        return dict(estado="aplicada", nome=ini, modo=modo, aviso=aviso,
                    meta=m_ini)

    def _termos_para(self, f, t):
        """Interpola os termos para a grade atual, e no tempo se for o caso."""
        from mwflow import solt

        chave = (float(f[0]), float(f[-1]), len(f), self.cal_modo)
        if self._termos_grade and self._termos_grade[0] == chave \
                and self.cal_modo != "interpolado":
            return self._termos_grade[1]
        base = self._cal_ini
        if base is None:
            return None
        if self.cal_modo == "final" and self._cal_fim is not None:
            base = self._cal_fim
        elif self.cal_modo == "interpolado" and self._cal_fim is not None:
            dur = max(1e-6, (self._cal_t1 or 0) - (self._cal_t0 or 0))
            peso = (t - (self._cal_t0 or t)) / dur
            base = solt.mistura_no_tempo(self._cal_ini, self._cal_fim, peso)
        try:
            termos = solt.interpola(base, f)
        except ValueError as e:
            self._publica(dict(tipo="erro", nivel="aviso", codigo="cal_fora",
                               msg=str(e)))
            self.correcao = None
            self.cal_nome = None
            return None
        self._termos_grade = (chave, termos)
        return termos

    # ------------------------------------------------------------- captura
    def _inicia_captura(self, c):
        """Junta N medidas da mesma amostra e devolve média, desvio e brutos.

        Guardar as N medidas individuais, e não só a média, é o que permite
        medir σ por nível em vez de supor um valor — e é esse σ que vira o
        limite de detecção.
        """
        alvo = c.get("obs", "derivado:f_res")
        tipo, _, nome = alvo.partition(":")
        self._captura = dict(
            tipo=tipo, nome=nome, n=max(1, int(c.get("n_med", 5))),
            f_alvo_hz=float(c.get("f_alvo_hz") or self.f_cw),
            meta=dict(x=c.get("x"),
                      # a covariável da curva, seja ela qual for; `temperatura_c`
                      # é o nome antigo do mesmo campo
                      cov=c.get("cov", c.get("temperatura_c")),
                      replica=c.get("replica"), ordem=c.get("ordem"),
                      x_ref=c.get("x_ref"), nota=c.get("nota"),
                      curva_id=c.get("curva_id"), obs=alvo),
            brutos=[], recusas=0, t0=time.time())
        self._publica(dict(tipo="captura", estado="iniciada",
                           faltam=self._captura["n"]))

    def _acumula(self, valor, ok=True, motivo=None):
        cap = self._captura
        if cap is None:
            return
        if not ok or valor is None or not math.isfinite(valor):
            cap["recusas"] += 1
            if cap["recusas"] > 4 * cap["n"]:
                self._publica(dict(tipo="captura", estado="falhou",
                                   msg="recusas demais: %s" % (motivo or "")))
                self._captura = None
            return
        cap["brutos"].append(float(valor))
        self._publica(dict(tipo="captura", estado="andando",
                           faltam=cap["n"] - len(cap["brutos"])))
        if len(cap["brutos"]) < cap["n"]:
            return

        v = np.array(cap["brutos"], float)
        msg = dict(tipo="ponto", t=time.time(),
                   y=float(v.mean()),
                   y_desvio=float(v.std(ddof=1)) if len(v) > 1 else 0.0,
                   n_med=len(v), brutos=[float(a) for a in v],
                   recusas=cap["recusas"], **cap["meta"])
        self._publica(msg)
        if self.sessao:
            self.sessao.grava_evento("info", "ponto",
                                     json.dumps({k: msg[k] for k in
                                                 ("x", "y", "y_desvio", "n_med")}))
        self._captura = None

    def _salva_ultima(self, c=None):
        if not (self.sessao and self._ultima):
            self._publica(dict(tipo="erro", nivel="aviso", codigo="sem_sessao",
                               msg="abra uma sessão antes de salvar"))
            return
        f, s11, s21, msg = self._ultima
        self.sessao.grava_varredura(msg, f, s11, s21,
                                    temperatura=(c or {}).get("temperatura_c"),
                                    rotulo=(c or {}).get("rotulo"))
        self._publica(dict(tipo="mensagem", msg="varredura gravada na sessão"))

    # -------------------------------------------------------------- o laço
    def _laco(self):
        try:
            self.identidade = self.vna.info()
        except ErroVNA as e:
            self.ultimo_erro = str(e)
            self._publica(dict(tipo="erro", nivel="erro", codigo="sem_aparelho",
                               msg=str(e)))
            self._publica(self.estado())
            # segue vivo: o operador pode religar o cabo
        self._reconfigura()
        self._publica(self.estado())

        t_estado = 0.0
        while not self._parar.is_set():
            if self._aplica_comandos():
                self._reconfigura()
                self._publica(self.estado())

            if self.modo == "parado":
                time.sleep(0.05)
                if time.time() - t_estado > 1.0:
                    t_estado = time.time()
                    self._publica(self.estado())
                continue

            try:
                if self.modo == "cw":
                    self._passo_cw()
                else:
                    self._passo_varredura()
                self.ultimo_erro = None
            except Abortado:
                self._abortar.clear()      # descarta a parcial; é o esperado
            except ErroVNA as e:
                self.ultimo_erro = str(e)
                self._publica(dict(tipo="erro", nivel="erro",
                                   codigo="falha_aquisicao", msg=str(e)))
                self._recupera()

            if time.time() - t_estado > 1.0:
                t_estado = time.time()
                self._publica(self.estado())

    def _reconfigura(self):
        """Aplica a configuração no aparelho. Só entre aquisições."""
        self._abortar.clear()
        self.geracao += 1
        self.portoes.reinicia()
        self.base.zera()
        self._n_cw = 0
        if self.modo == "parado":
            return
        try:
            if self.modo == "cw":
                self.vna.define_cw(self.f_cw, bloco=self.bloco_cw,
                                   valores_por_f=1)
            else:
                n = min(int(self.pontos), p.PONTOS_MAX)
                self.pontos = n
                self.vna.define_varredura(self.f_inicio, self.f_fim, n,
                                          valores_por_f=self.vpf)
        except (ErroVNA, ValueError) as e:
            self.ultimo_erro = str(e)
            self._publica(dict(tipo="erro", nivel="erro", codigo="config",
                               msg=str(e)))
            self.modo = "parado"

    def _recupera(self):
        """Escada de recuperação: ressincroniza, e só então reabre a porta."""
        for tentativa in range(3):
            try:
                self.vna.ressincroniza()
                self.vna.confere()
                self._reconfigura()
                return
            except Exception:
                time.sleep(0.3 * (tentativa + 1))
        try:
            self.vna.fecha()
            time.sleep(0.5)
            self.vna.abre()
            self.vna.abortar = self._abortar
            self._reconfigura()
        except Exception as e:
            self._publica(dict(tipo="erro", nivel="erro", codigo="offline",
                               msg="aparelho fora do ar: %s" % e))
            self.modo = "parado"

    # --------------------------------------------------------------- aquisição
    def _passo_varredura(self):
        t0 = time.time()
        f, s11, s21, desvio = self.vna.varre_media(self.medias)
        dt = time.time() - t0
        agora = time.time()

        # Os padrões de calibração são medidos SEM correção. Aplicar a
        # correção velha em cima deles produziria uma calibração encadeada,
        # que é lixo. Por isso isto vem antes.
        if self._cal_pedido is not None:
            self._mede_padrao(f, s11, s21)

        bruto11, bruto21 = s11, s21
        if self.correcao is not None:
            s11, s21 = self.correcao(f, s11, s21, agora)

        self.seq += 1
        n = len(f)
        self.taxa_pontos = n * self.medias / dt if dt > 0 else float("nan")
        self.taxa_varreduras = 1.0 / dt if dt > 0 else float("nan")

        self._publica(dict(
            tipo="varredura", seq=self.seq, geracao=self.geracao, t=agora,
            f_inicio_hz=float(f[0]), f_passo_hz=float(f[1] - f[0]) if n > 1 else 0.0,
            n=n, medias=self.medias, cal=self._rotulo_cal(),
            sem_dado=int(np.isnan(s11).sum()),
            _arrays=(s11, s21)))

        s = s21 if self.param == "s21" else s11
        v, ok, motivo, banda = self.portoes.estima(f, s, self.banda)
        modelo = v.pop("_modelo", None) if v else None
        self._publica(dict(
            tipo="escalar", seq=self.seq, geracao=self.geracao, t=agora,
            param=self.param, valores=(_limpa(v) if v else None), ok=bool(ok),
            motivo=motivo, banda_hz=[float(banda[0]), float(banda[1])],
            modelo=modelo, estimador="ajuste-1polo"))

        with np.errstate(divide="ignore", invalid="ignore"):
            linha = 20 * np.log10(np.abs(s))
        self._publica(dict(
            tipo="linha_espectro", seq=self.seq, geracao=self.geracao, t=agora,
            f_inicio_hz=float(f[0]),
            f_passo_hz=float(f[1] - f[0]) if n > 1 else 0.0, n=n,
            param=self.param, _arrays=(linha,)))

        cabecalho = dict(seq=self.seq, t=agora, modo="varredura",
                         vpf=self.vpf, medias=self.medias,
                         cal=self._rotulo_cal(),
                         sem_dado=int(np.isnan(s11).sum()))
        # No disco vai o BRUTO, sempre. A correção é da leitura.
        self._ultima = (f, bruto11, bruto21, cabecalho)
        if self.sessao and self.gravando:
            self.sessao.grava_varredura(cabecalho, f, bruto11, bruto21)
            self.sessao.grava_ajuste(dict(t=agora, param=self.param,
                                          valores=v, banda_hz=list(banda),
                                          ok=ok, motivo=motivo,
                                          estimador="ajuste-1polo"))
        if self._captura is not None:
            if self._captura["tipo"] == "derivado":
                self._acumula(v.get(self._captura["nome"]) if v else None,
                              ok, motivo)
            else:
                try:
                    val = ob.escalar_em(self._captura["nome"], f, s,
                                        self._captura["f_alvo_hz"])
                    self._acumula(val, True)
                except Exception as e:
                    self._acumula(None, False, str(e))

    def _passo_cw(self):
        n = self.bloco_cw
        s11, s21 = self.vna.amostras_cw(n)
        chegada = time.time()
        if self.correcao is not None:
            f = np.full(n, self.f_cw)
            s11, s21 = self.correcao(f, s11, s21, chegada)

        self.base.registra(self._n_cw + n, chegada)
        t = self.base.instantes(self._n_cw, n)
        self._n_cw += n
        self.seq += 1
        self.taxa_pontos = self.base.taxa

        s = s21 if self.param == "s21" else s11
        self._publica(dict(
            tipo="amostras_cw", seq=self.seq, geracao=self.geracao,
            t=chegada, f_hz=self.f_cw, n=n, param=self.param,
            taxa_s=float(self.base.taxa), cal=self._rotulo_cal(),
            _arrays=(t.astype(np.float64), s)))

        if self._captura is not None:
            if self._captura["tipo"] != "traco":
                self._acumula(None, False,
                              "grandeza derivada exige varredura, não CW")
                return
            o = ob.REGISTRO[self._captura["nome"]]
            fa = np.full(n, self.f_cw)
            vals = o.calcula(fa, s)
            for x in vals:
                if self._captura is None:
                    break
                self._acumula(float(x), True)

    # ----------------------------------------------------------------- estado
    def _rotulo_cal(self):
        return "bruto" if self.correcao is None else "aplicada"

    def estado(self):
        return dict(
            tipo="estado",
            aparelho=("simulado" if self.simulado else
                      ("litevna" if self.identidade else "offline")),
            identidade=self.identidade,
            modo=self.modo, geracao=self.geracao, seq=self.seq,
            config=dict(f_inicio_hz=self.f_inicio, f_fim_hz=self.f_fim,
                        n_pontos=self.pontos, vpf=self.vpf,
                        medias=self.medias, f_cw_hz=self.f_cw,
                        bloco_cw=self.bloco_cw),
            param=self.param, banda_hz=[self.banda[0], self.banda[1]],
            taxa_pontos_s=_num(self.taxa_pontos),
            taxa_varreduras_s=_num(self.taxa_varreduras),
            pontos_max=p.PONTOS_MAX, cal=self._rotulo_cal(),
            cal_nome=self.cal_nome, cal_modo=self.cal_modo,
            cal_padroes=sorted(self.cal_medidas),
            sessao=(self.sessao.nome if self.sessao else None),
            gravando=bool(self.gravando),
            erro=self.ultimo_erro)


def _num(x):
    """JSON não tem NaN nem infinito. Vira `None`."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _limpa(d):
    return {k: _num(v) for k, v in d.items()}
