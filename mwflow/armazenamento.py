#!/usr/bin/env python3
"""Gravação: SQLite, CSV nativo do LiteVNA e Touchstone.

TRÊS FORMATOS, TRÊS RAZÕES

- **SQLite** é a verdade. Uma base só para todas as sessões, porque uma curva de
  calibração atravessa sessões e a consulta cruzada é o ponto.
- **CSV nativo do LiteVNA** é a ponte. Mesmo separador, mesma vírgula decimal e
  as mesmas nove colunas dos dados históricos, para o `artigo/analise.py` e o
  `microondas-ph/ph_analise.py` lerem uma medida nova sem uma linha de mudança.
- **Touchstone** é a saída para fora, com um comentário dizendo em letras
  claras que S12 e S22 não foram medidos.

O QUE VAI NO DISCO. Guardamos o S11 e o S21 **sem calibração**. A correção é
aplicada na leitura, nunca na gravação. Por isso trocar de conjunto de
calibração — ou de modo do colchete — depois da medida é sempre possível e
nunca destrói dado.

Não guardamos as contagens inteiras da FIFO. Elas não acrescentam nada para
recalibrar: a correção age sobre as razões `rev/fwd`, e a referência `fwd` se
cancela. Guardá-las custaria 50 % a mais de espaço por nenhum ganho.

A ESCRITA MORA NUMA THREAD SÓ. A thread de aquisição nunca toca no disco; ela
enfileira. Se a fila encher, o erro é gritado e contado — perda silenciosa de
dado é inaceitável.
"""

import json
import os
import queue
import sqlite3
import threading
import time

import numpy as np

from mwflow.caminhos import BANCO, SESSOES, garante

CODEC = "c64x2"      # s11 e s21 em complex64, intercalados

ESQUEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessoes (
  id INTEGER PRIMARY KEY, nome TEXT UNIQUE NOT NULL, criada_em TEXT NOT NULL,
  encerrada_em TEXT, operador TEXT, descricao TEXT,
  aparelho TEXT NOT NULL, firmware TEXT, versao TEXT,
  cal_ini_id INTEGER REFERENCES conjuntos_cal(id),
  cal_fim_id INTEGER REFERENCES conjuntos_cal(id),
  modo_cal TEXT NOT NULL DEFAULT 'inicial',
  reverif_json TEXT, config_json TEXT, pasta TEXT);

CREATE TABLE IF NOT EXISTS varreduras (
  id INTEGER PRIMARY KEY,
  sessao_id INTEGER NOT NULL REFERENCES sessoes(id),
  seq INTEGER NOT NULL, t REAL NOT NULL, modo TEXT NOT NULL,
  f_inicio_hz REAL NOT NULL, f_passo_hz REAL NOT NULL, n INTEGER NOT NULL,
  vpf INTEGER NOT NULL DEFAULT 1, medias INTEGER NOT NULL DEFAULT 1,
  cal_estado TEXT NOT NULL DEFAULT 'bruto', codec TEXT NOT NULL,
  dados BLOB NOT NULL, sem_dado INTEGER NOT NULL DEFAULT 0,
  temperatura_c REAL, rotulo TEXT);
CREATE INDEX IF NOT EXISTS ix_varr_sessao ON varreduras(sessao_id, seq);
CREATE INDEX IF NOT EXISTS ix_varr_t ON varreduras(t);

CREATE TABLE IF NOT EXISTS ajustes (
  id INTEGER PRIMARY KEY,
  varredura_id INTEGER REFERENCES varreduras(id),
  sessao_id INTEGER REFERENCES sessoes(id),
  t REAL NOT NULL, parametro TEXT NOT NULL,
  banda_lo_hz REAL, banda_hi_hz REAL,
  f_res REAL, q REAL, il_db REAL, rms REAL, fwhm_mhz REAL, prominencia_db REAL,
  estimador TEXT NOT NULL DEFAULT 'ajuste-1polo',
  ok INTEGER NOT NULL, motivo TEXT);
CREATE INDEX IF NOT EXISTS ix_aj_sessao ON ajustes(sessao_id, t);

CREATE TABLE IF NOT EXISTS conjuntos_cal (
  id INTEGER PRIMARY KEY, nome TEXT UNIQUE NOT NULL, criado_em TEXT NOT NULL,
  tipo TEXT NOT NULL, f_inicio_hz REAL, f_passo_hz REAL, n INTEGER,
  kit_json TEXT NOT NULL, isolamento INTEGER NOT NULL DEFAULT 0,
  medias INTEGER, cond_max REAL, arquivo TEXT NOT NULL,
  aparelho TEXT, firmware TEXT, temperatura_c REAL, nota TEXT);

CREATE TABLE IF NOT EXISTS curvas (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, criada_em TEXT NOT NULL,
  sessao_id INTEGER REFERENCES sessoes(id),
  analito TEXT, unidade_x TEXT NOT NULL,
  grandeza_x TEXT, covariavel TEXT, unidade_cov TEXT,
  cov_exigida INTEGER NOT NULL DEFAULT 1,
  observavel TEXT NOT NULL, param TEXT, banda_lo_hz REAL, banda_hi_hz REAL,
  f_alvo_hz REAL, semente INTEGER, descricao TEXT);

CREATE TABLE IF NOT EXISTS pontos_curva (
  id INTEGER PRIMARY KEY, curva_id INTEGER NOT NULL REFERENCES curvas(id),
  varredura_id INTEGER REFERENCES varreduras(id),
  x REAL NOT NULL, y REAL NOT NULL, y_desvio REAL, n_med INTEGER NOT NULL DEFAULT 1,
  brutos_json TEXT, temperatura_c REAL, temperatura_origem TEXT DEFAULT 'manual',
  cov REAL,
  replica TEXT, ordem_sorteada INTEGER, ordem_execucao INTEGER,
  x_ref REAL, t REAL NOT NULL, incluido INTEGER NOT NULL DEFAULT 1, nota TEXT);
CREATE INDEX IF NOT EXISTS ix_pc_curva ON pontos_curva(curva_id);

CREATE TABLE IF NOT EXISTS ajustes_curva (
  id INTEGER PRIMARY KEY, curva_id INTEGER NOT NULL REFERENCES curvas(id),
  criado_em TEXT NOT NULL, tipo TEXT NOT NULL, grau INTEGER,
  faixa_lo REAL, faixa_hi REAL, n INTEGER NOT NULL,
  coefs_json TEXT NOT NULL, cov_json TEXT, r2 REAL, r2_aj REAL, s_yx REAL,
  sensibilidade REAL, unidade_sens TEXT, sigma_y REAL, sigma_origem TEXT,
  lod REAL, loq REAL, nota TEXT);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY, sessao_id INTEGER REFERENCES sessoes(id),
  t REAL NOT NULL, nivel TEXT NOT NULL, codigo TEXT, msg TEXT NOT NULL);
"""


# --------------------------------------------------------------- codificação
def empacota(s11, s21):
    """Dois vetores complexos num BLOB: [re11 im11 re21 im21], float32."""
    a = np.asarray(s11, dtype=np.complex64)
    b = np.asarray(s21, dtype=np.complex64)
    return (np.stack([a.real, a.imag, b.real, b.imag]).astype(np.float32)
            .tobytes())


def desempacota(blob, n):
    v = np.frombuffer(blob, dtype=np.float32).reshape(4, n)
    return (v[0] + 1j * v[1]).astype(np.complex128), \
           (v[2] + 1j * v[3]).astype(np.complex128)


# ------------------------------------------------------------------- banco
#: Colunas acrescentadas depois da primeira versão do esquema. O
#: `CREATE TABLE IF NOT EXISTS` não toca numa tabela que já existe, então uma
#: base gravada antes desta versão não ganharia as colunas novas — e a inserção
#: falharia com "no such column" na primeira curva. A lista abaixo é aplicada em
#: toda abertura de escrita, e um `ALTER TABLE ADD COLUMN` do SQLite não move
#: dado nenhum.
COLUNAS_NOVAS = [
    ("curvas", "grandeza_x", "TEXT"),
    ("curvas", "covariavel", "TEXT"),
    ("curvas", "unidade_cov", "TEXT"),
    ("curvas", "cov_exigida", "INTEGER NOT NULL DEFAULT 1"),
    ("pontos_curva", "cov", "REAL"),
]


def migra(con):
    """Acrescenta as colunas que faltam. Chamada em toda abertura de escrita."""
    for tabela, coluna, tipo in COLUNAS_NOVAS:
        tem = {r["name"] for r in con.execute("PRAGMA table_info(%s)" % tabela)}
        if coluna not in tem:
            con.execute("ALTER TABLE %s ADD COLUMN %s %s"
                        % (tabela, coluna, tipo))
    con.commit()


def conecta(caminho=None, leitura=False):
    c = sqlite3.connect(caminho or BANCO, timeout=15.0,
                        check_same_thread=False)
    c.row_factory = sqlite3.Row
    if not leitura:
        c.executescript(ESQUEMA)
        migra(c)
    return c


class Gravadora(threading.Thread):
    """Thread única de escrita. A aquisição enfileira e segue medindo."""

    def __init__(self, caminho=None, limite=512):
        super().__init__(name="gravadora", daemon=True)
        self.caminho = caminho or BANCO
        self.fila = queue.Queue(maxsize=limite)
        self.perdas = 0
        self._parar = threading.Event()
        self.con = None
        self.pronta = threading.Event()

    def run(self):
        self.con = conecta(self.caminho)
        self.pronta.set()
        while not (self._parar.is_set() and self.fila.empty()):
            try:
                tarefa = self.fila.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                tarefa(self.con)
                self.con.commit()
            except Exception as e:                       # nunca derruba a thread
                print("gravadora: %s" % e)
        try:
            self.con.commit()
            self.con.close()
        except Exception:
            pass

    def envia(self, tarefa):
        try:
            self.fila.put_nowait(tarefa)
            return True
        except queue.Full:
            self.perdas += 1
            print("gravadora: fila cheia, %d perdas acumuladas" % self.perdas)
            return False

    def encerra(self, prazo=5.0):
        self._parar.set()
        self.join(prazo)


# ------------------------------------------------------------------ sessão
class Sessao:
    """Uma campanha de medida: pasta em disco e linha no banco."""

    def __init__(self, gravadora, nome=None, operador="", descricao="",
                 aparelho="litevna", firmware="", config=None):
        self.g = gravadora
        self.nome = nome or time.strftime("s%Y-%m-%d_%H%M%S")
        self.pasta = os.path.join(SESSOES, self.nome)
        garante(self.pasta, os.path.join(self.pasta, "varreduras"),
                os.path.join(self.pasta, "touchstone"))
        self.id = None
        self.aparelho = aparelho
        self.n_varreduras = 0
        self.gravando = False
        self._cria(operador, descricao, firmware, config or {})

    def _cria(self, operador, descricao, firmware, config):
        con = conecta()
        cur = con.execute(
            "INSERT INTO sessoes (nome, criada_em, operador, descricao, "
            "aparelho, firmware, versao, config_json, pasta) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (self.nome, _agora(), operador, descricao, self.aparelho,
             firmware, "0.1.0", json.dumps(config), self.pasta))
        self.id = cur.lastrowid
        con.commit()
        con.close()
        with open(os.path.join(self.pasta, "meta.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(dict(nome=self.nome, criada_em=_agora(),
                           operador=operador, descricao=descricao,
                           aparelho=self.aparelho, firmware=firmware,
                           config=config), fh, ensure_ascii=False, indent=2)

    def encerra(self, reverif=None, modo_cal=None):
        sid = self.id

        def tarefa(con):
            con.execute("UPDATE sessoes SET encerrada_em=?, reverif_json=?, "
                        "modo_cal=COALESCE(?, modo_cal) WHERE id=?",
                        (_agora(), json.dumps(reverif) if reverif else None,
                         modo_cal, sid))
        self.g.envia(tarefa)

    # ------------------------------------------------------------- varredura
    def grava_varredura(self, msg, f, s11, s21, temperatura=None, rotulo=None):
        """Enfileira uma varredura. Só grava quando a gravação está armada."""
        sid, n = self.id, len(f)
        blob = empacota(s11, s21)
        arq = os.path.join(self.pasta, "varreduras",
                           "%06d.csv" % (self.n_varreduras + 1))
        self.n_varreduras += 1
        dados = (sid, int(msg["seq"]), float(msg["t"]), msg.get("modo", "varredura"),
                 float(f[0]), float(f[1] - f[0]) if n > 1 else 0.0, n,
                 int(msg.get("vpf", 1)), int(msg.get("medias", 1)),
                 msg.get("cal", "bruto"), CODEC, blob,
                 int(msg.get("sem_dado", 0)), temperatura, rotulo)

        def tarefa(con):
            con.execute(
                "INSERT INTO varreduras (sessao_id, seq, t, modo, f_inicio_hz, "
                "f_passo_hz, n, vpf, medias, cal_estado, codec, dados, "
                "sem_dado, temperatura_c, rotulo) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dados)
            escreve_csv_litevna(arq, f, s11, s21)
        return self.g.envia(tarefa)

    def grava_ajuste(self, msg):
        sid = self.id
        v = msg.get("valores") or {}
        b = msg.get("banda_hz") or [None, None]
        dados = (sid, float(msg["t"]), msg.get("param", "s21"), b[0], b[1],
                 v.get("f_res"), v.get("q"), v.get("il_db"), v.get("rms"),
                 v.get("fwhm_mhz"), v.get("prominencia_db"),
                 msg.get("estimador", "ajuste-1polo"),
                 1 if msg.get("ok") else 0, msg.get("motivo"))

        def tarefa(con):
            con.execute(
                "INSERT INTO ajustes (sessao_id, t, parametro, banda_lo_hz, "
                "banda_hi_hz, f_res, q, il_db, rms, fwhm_mhz, prominencia_db, "
                "estimador, ok, motivo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                dados)
        return self.g.envia(tarefa)

    def grava_evento(self, nivel, codigo, msg):
        sid = self.id

        def tarefa(con):
            con.execute("INSERT INTO eventos (sessao_id, t, nivel, codigo, msg) "
                        "VALUES (?,?,?,?,?)", (sid, time.time(), nivel, codigo, msg))
        return self.g.envia(tarefa)


def _agora():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# -------------------------------------------------- CSV nativo do LiteVNA
def escreve_csv_litevna(caminho, f, s11, s21):
    """Formato exato dos arquivos históricos.

    Campos de largura fixa, alinhados à direita, separador `;`, vírgula
    decimal, mantissa `%.9e`, fim de linha CRLF, sem cabeçalho, nove colunas.
    As quatro últimas são zero — no aparelho elas seriam S12 e S22, que este
    hardware não mede. A coincidência é feliz: o formato nativo já registra a
    ausência da chave de reversão.
    """
    n = len(f)
    linhas = []
    for i in range(n):
        campos = [s11[i].real, s11[i].imag, s21[i].real, s21[i].imag,
                  0.0, 0.0, 0.0, 0.0]
        txt = "%15d" % int(round(float(f[i])))
        for v in campos:
            v = float(v) if np.isfinite(v) else 0.0
            txt += ";%19s" % ("%.9e" % v).replace(".", ",")
        linhas.append(txt)
    with open(caminho, "w", encoding="ascii", newline="") as fh:
        fh.write("\r\n".join(linhas) + "\r\n")


def le_csv_litevna(caminho):
    """Leitor gêmeo, para o teste de ida e volta contra os arquivos antigos."""
    fs, a, b = [], [], []
    with open(caminho, "r", encoding="ascii") as fh:
        for linha in fh:
            if not linha.strip():
                continue
            p = [float(x.strip().replace(",", ".")) for x in linha.split(";")]
            fs.append(p[0])
            a.append(complex(p[1], p[2]))
            b.append(complex(p[3], p[4]))
    return np.array(fs), np.array(a), np.array(b)


# ------------------------------------------------------------- Touchstone
def escreve_touchstone(caminho, f, s11, s21=None, meta=None,
                       s12_reciproco=False):
    """`.s1p` quando só há S11; `.s2p` quando há S21.

    A ordem das colunas do `.s2p` é S11 S21 S12 S22 — trocá-la é o defeito
    clássico deste formato.
    """
    meta = meta or {}
    dois = s21 is not None
    L = ["!MWFlow 0.1.0",
         "!Data: %s" % _agora()]
    for k in ("sessao", "seq", "aparelho", "firmware", "calibracao",
              "temperatura_c", "nota"):
        if meta.get(k) is not None:
            L.append("!%s: %s" % (k.capitalize(), meta[k]))
    if dois:
        L += ["!ATENCAO: hardware sem chave de reversao. S12 e S22 NAO foram",
              "!         medidos.%s Nao os interprete como medida."
              % (" S12 recebeu o valor de S21 por hipotese de reciprocidade."
                 if s12_reciproco else " Eles saem preenchidos com zero.")]
    L.append("# Hz S RI R 50")
    L.append("!%14s %18s %18s%s" % ("Frequencia", "Re", "Im",
                                    "" if not dois else
                                    " %18s %18s %18s %18s %18s %18s"
                                    % ("Re(S21)", "Im(S21)", "Re(S12)",
                                       "Im(S12)", "Re(S22)", "Im(S22)")))
    for i in range(len(f)):
        linha = "%15d %18.9e %18.9e" % (int(round(float(f[i]))),
                                        s11[i].real, s11[i].imag)
        if dois:
            s12 = s21[i] if s12_reciproco else 0j
            linha += (" %18.9e %18.9e %18.9e %18.9e %18.9e %18.9e"
                      % (s21[i].real, s21[i].imag, s12.real, s12.imag, 0.0, 0.0))
        L.append(linha)
    with open(caminho, "w", encoding="ascii") as fh:
        fh.write("\n".join(L) + "\n")


def exporta_npz(caminho, f, s11, s21):
    """Chaves `f`, `s11`, `s21` — as mesmas que `sensor_etanol.ajuste` carrega.

    Com isso uma sessão do MWFlow entra na análise já existente sem adaptação.
    """
    np.savez_compressed(caminho, f=np.asarray(f), s11=np.asarray(s11),
                        s21=np.asarray(s21))
