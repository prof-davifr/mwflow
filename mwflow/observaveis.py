#!/usr/bin/env python3
"""Registro de grandezas medidas.

Uma grandeza aqui é uma função pura de uma varredura. Existem dois tipos:

- **traço**: vale ponto a ponto na grade de frequências. Alimenta o
  espectrograma direto, e vira um escalar quando amostrado numa frequência.
- **derivado**: sai de um ajuste sobre uma banda. Não existe numa frequência
  só — e a interface usa esse fato para não deixar o operador pedir `f_res` em
  modo de frequência fixa.

O mesmo registro alimenta o eixo Y do osciloscópio e o eixo Y da curva de
calibração. Acrescentar uma grandeza é escrever uma função aqui; o navegador
monta os menus a partir de `catalogo()` e não precisa de mudança nenhuma.
"""

from dataclasses import dataclass
from typing import Callable

import numpy as np

from mwflow.ajuste import ajusta

Z0 = 50.0

REGISTRO = {}


@dataclass(frozen=True)
class Observavel:
    id: str
    rotulo: str
    unidade: str
    tipo: str           # "traco" | "derivado"
    escala: str         # "linear" | "log"
    calcula: Callable
    saidas: tuple = ()  # nomes dos escalares, quando derivado

    def json(self):
        return dict(id=self.id, rotulo=self.rotulo, unidade=self.unidade,
                    tipo=self.tipo, escala=self.escala,
                    saidas=list(self.saidas))


def _registra(id, rotulo, unidade, tipo="traco", escala="linear", saidas=()):
    def deco(fn):
        REGISTRO[id] = Observavel(id, rotulo, unidade, tipo, escala, fn, saidas)
        return fn
    return deco


def catalogo():
    """Lista serializável, para o navegador montar os menus."""
    return [o.json() for o in REGISTRO.values()]


# ------------------------------------------------------------------- traços
@_registra("mag_db", "|S| (dB)", "dB")
def _mag_db(f, s):
    with np.errstate(divide="ignore", invalid="ignore"):
        return 20 * np.log10(np.abs(s))


@_registra("mag_lin", "|S|", "")
def _mag_lin(f, s):
    return np.abs(s)


@_registra("fase_deg", "fase de S", "graus")
def _fase(f, s):
    return np.degrees(np.angle(s))


@_registra("fase_desdobrada", "fase desdobrada de S", "graus")
def _fase_d(f, s):
    return np.degrees(np.unwrap(np.angle(s)))


@_registra("re", "Re(S)", "")
def _re(f, s):
    return np.real(s)


@_registra("im", "Im(S)", "")
def _im(f, s):
    return np.imag(s)


@_registra("vswr", "VSWR", "", escala="log")
def _vswr(f, s):
    m = np.clip(np.abs(s), 0, 0.999999)
    return (1 + m) / (1 - m)


@_registra("z_re", "Re(Z)", "ohm")
def _z_re(f, s):
    return np.real(Z0 * (1 + s) / (1 - s))


@_registra("z_im", "Im(Z)", "ohm")
def _z_im(f, s):
    return np.imag(Z0 * (1 + s) / (1 - s))


@_registra("atraso_grupo", "atraso de grupo", "s")
def _atraso(f, s):
    """-dφ/dω por diferença central. As pontas repetem a vizinha."""
    fase = np.unwrap(np.angle(s))
    d = np.gradient(fase, f)
    return -d / (2 * np.pi)


# ---------------------------------------------------------------- derivados
SAIDAS_AJUSTE = ("f_res", "q", "il_db", "rms", "fwhm_mhz", "prominencia_db")


def coeficientes(f, s, f0, q, banda):
    """Recupera C e A do modelo, com f0 e Q já fixados pelo ajuste.

    Com f0 e Q conhecidos o modelo `S21 = C + A·L(f)` é LINEAR em C e A, então
    isso é um mínimos quadrados exato de duas incógnitas, sem iteração. Serve
    para desenhar a curva ajustada por cima dos dados: quando o ajuste está
    ruim, o operador vê na hora, em vez de confiar num número.

    Devolve também a proeminência — a altura do pico sobre o fundo |C|, que é a
    coluna `prominencia_db` do `metrics.json` do sensor-etanol.
    """
    sel = (f >= banda[0]) & (f <= banda[1])
    ff, ss = f[sel], s[sel]
    L = 1.0 / (1 + 2j * q * (ff - f0) / f0)
    M = np.column_stack([np.ones_like(L), L])
    sol, *_ = np.linalg.lstsq(M, ss, rcond=None)
    return complex(sol[0]), complex(sol[1])


@_registra("ajuste_1polo", "ajuste de 1 polo (f_res, Q, IL)", "",
           tipo="derivado", saidas=SAIDAS_AJUSTE)
def _ajuste(f, s, banda):
    r = ajusta(f, s, banda)
    if r is None:
        return None
    fwhm = r["f0"] / r["Q"] / 1e6 if r["Q"] else float("nan")
    prom = float("nan")
    c = a = None
    try:
        c, a = coeficientes(f, s, r["f0"], r["Q"], banda)
        pico = abs(c + a)
        fundo = abs(c)
        if pico > 0 and fundo > 0:
            prom = float(20 * np.log10(pico / fundo))
    except Exception:
        pass
    d = dict(f_res=r["f0"], q=r["Q"], il_db=r["il_db"], rms=r["rms"],
             fwhm_mhz=fwhm, prominencia_db=prom)
    if c is not None:
        d["_modelo"] = [c.real, c.imag, a.real, a.imag]
    return d


UNIDADE_ESCALAR = dict(f_res="Hz", q="", il_db="dB", rms="",
                       fwhm_mhz="MHz", prominencia_db="dB")
ROTULO_ESCALAR = dict(f_res="f_res", q="Q", il_db="IL", rms="rms do ajuste",
                      fwhm_mhz="largura a meia altura",
                      prominencia_db="proeminência")


# ---------------------------------------------------------------- amostragem
def amostra(f, s, f_alvo):
    """Valor COMPLEXO de `s` em `f_alvo`, por interpolação.

    A interpolação é feita nas partes real e imaginária, nunca na fase em
    graus: uma fase interpolada por cima da volta de +180° para -180° dá
    resultado sem sentido. O valor complexo nunca dá.
    """
    f = np.asarray(f, float)
    if f_alvo <= f[0]:
        return s[0]
    if f_alvo >= f[-1]:
        return s[-1]
    i = int(np.searchsorted(f, f_alvo)) - 1
    t = (f_alvo - f[i]) / (f[i + 1] - f[i])
    return s[i] * (1 - t) + s[i + 1] * t


def escalar_em(obs_id, f, s, f_alvo):
    """Escalar de um observável de traço, numa frequência."""
    o = REGISTRO[obs_id]
    if o.tipo != "traco":
        raise ValueError("%s é derivado; ele não existe numa frequência só"
                         % obs_id)
    z = amostra(f, s, f_alvo)
    return float(o.calcula(np.array([f_alvo]), np.array([z]))[0])


# ------------------------------------------------------------- portões
class Portoes:
    """Guarda-corpo em volta de `ajusta()`.

    `ajusta()` usa `method="lm"`, que ignora limites. Num laço ao vivo ele
    ocasionalmente foge. Estes portões devolvem `ok=False` com o motivo, em
    vez de deixar um ajuste ruim virar ponto de calibração. Um ponto pulado em
    silêncio é muito pior do que uma recusa visível.
    """

    def __init__(self, rms_max=0.25, q_min=1.0, q_max=1e5,
                 salto_max_hz=None, banda_adaptativa=True, k_banda=3.0):
        self.rms_max = rms_max
        self.q_min = q_min
        self.q_max = q_max
        self.salto_max_hz = salto_max_hz
        self.banda_adaptativa = banda_adaptativa
        self.k_banda = k_banda
        self.anterior = None

    def reinicia(self):
        """Chame após qualquer troca de banda ou de configuração."""
        self.anterior = None

    def banda_de(self, banda_pedida, f):
        """Estreita a banda em volta do último pico, quando isso é seguro."""
        if not (self.banda_adaptativa and self.anterior):
            return banda_pedida
        f0 = self.anterior["f_res"]
        fw = self.anterior["fwhm_mhz"] * 1e6
        if not np.isfinite(f0) or not np.isfinite(fw) or fw <= 0:
            return banda_pedida
        lo = max(banda_pedida[0], f0 - self.k_banda * fw)
        hi = min(banda_pedida[1], f0 + self.k_banda * fw)
        # precisa sobrar grade suficiente para o ajuste
        if ((f >= lo) & (f <= hi)).sum() < 20:
            return banda_pedida
        return (lo, hi)

    def estima(self, f, s, banda):
        """Devolve (valores, ok, motivo, banda_usada)."""
        if not np.isfinite(s).all():
            n = int((~np.isfinite(s)).sum())
            return None, False, "%d pontos sem dado na varredura" % n, banda
        b = self.banda_de(banda, f)
        if ((f >= b[0]) & (f <= b[1])).sum() < 20:
            return None, False, "menos de 20 pontos na banda", b

        v = REGISTRO["ajuste_1polo"].calcula(f, s, b)
        if v is None:
            return None, False, "o ajuste não convergiu", b
        if not np.isfinite(v["rms"]) or v["rms"] > self.rms_max:
            return v, False, "resíduo alto (rms %.3g)" % v["rms"], b
        if not (self.q_min <= v["q"] <= self.q_max):
            return v, False, "Q fora do plausível (%.3g)" % v["q"], b
        if (self.salto_max_hz and self.anterior
                and abs(v["f_res"] - self.anterior["f_res"]) > self.salto_max_hz):
            d = (v["f_res"] - self.anterior["f_res"]) / 1e6
            return v, False, "salto de %+.2f MHz desde a última" % d, b

        self.anterior = v
        return v, True, None, b
