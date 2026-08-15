#!/usr/bin/env python3
"""Calibração SOLT: uma porta com três termos, e resposta melhorada para o S21.

MODELO DE UMA PORTA. O refletido medido se liga ao real por

    Gm = e00 + (e10e01 * Ga) / (1 - e11 * Ga)

Para resolver, use a forma bilinear equivalente, com de = e00*e11 - e10e01:

    Gm = (e00 - de*Ga) / (1 - e11*Ga)
    =>  e00*1 + e11*(Ga*Gm) + de*(-Ga) = Gm

Três padrões dão, EM CADA FREQUÊNCIA, um sistema linear complexo 3x3. Tudo é
resolvido de uma vez, com `np.linalg.solve` sobre um empilhamento (Nf, 3, 3).

CORREÇÃO:

    Ga = (Gm - e00) / (e11*(Gm - e00) + e10e01)

CONDICIONAMENTO. Se os três padrões caírem perto uns dos outros na carta de
Smith, o sistema fica malcondicionado e os termos de erro saem lixo — sem
nenhum aviso. Por isso o número de condição é calculado em cada frequência e
denunciado. É assim que um padrão mal conectado ou danificado aparece sozinho.

TRANSMISSÃO. Com isolamento `e30` e rastreio `e10e32`:

    S21a = ((S21m - e30) / e10e32) * (1 - e11 * S11a)

O último fator é a parte "melhorada": ele tira a rereflexão do descasamento da
fonte na entrada do dispositivo. Num ressoador, onde |S11| vai de quase 1 fora
da ressonância a 0,3 no pico, essa correção não é pequena.

O QUE ESTA CALIBRAÇÃO NÃO CORRIGE — e a interface tem de dizer:

- O casamento da porta 2 (`e22`) é INOBSERVÁVEL sem chave de reversão. O erro
  residual do S21 vale aproximadamente |e22 * S22|. Num ressoador de
  transmissão com acoplamento fraco, |S22| é grande fora da ressonância e
  varia rápido através dela, então esse termo **enviesa o Q**, e não apenas a
  amplitude. A correção é física e barata: um atenuador de 6 a 10 dB fixo na
  porta 2 melhora |e22| pelo dobro do valor em dB.
- S12 e S22 não são medidos. Nunca.
- Não existe correção de 12 termos aqui. Inverter o dispositivo na bancada não
  a produz: seria preciso também supor reciprocidade e que o dispositivo não
  muda ao ser desconectado — que é justamente o que a réplica com desmontagem
  do ROADMAP §F3 põe à prova.
"""

import hashlib
import json
import os
import time

import numpy as np

from mwflow import kit_cal
from mwflow.caminhos import CALS, garante

COND_LIMITE = 1e6


# --------------------------------------------------------------- resolução
def resolve_uma_porta(f, medidos, kit):
    """Termos de erro de uma porta.

    `medidos` traz os vetores complexos medidos de aberto, curto e carga.
    Devolve dict com e00, e11, e10e01 e o número de condição por frequência.
    """
    f = np.asarray(f, float)
    ideais = kit_cal.padroes(f, kit)
    nomes = ("aberto", "curto", "carga")
    nf = len(f)

    A = np.empty((nf, 3, 3), dtype=complex)
    b = np.empty((nf, 3), dtype=complex)
    for i, nome in enumerate(nomes):
        ga = np.asarray(ideais[nome], complex)
        gm = np.asarray(medidos[nome], complex)
        A[:, i, 0] = 1.0
        A[:, i, 1] = ga * gm
        A[:, i, 2] = -ga
        b[:, i] = gm

    cond = np.linalg.cond(A)
    x = np.linalg.solve(A, b[..., None])[..., 0]
    e00, e11, de = x[:, 0], x[:, 1], x[:, 2]
    e10e01 = e00 * e11 - de
    return dict(f=f, e00=e00, e11=e11, e10e01=e10e01, cond=cond)


def resolve_transmissao(f, thru_medido, e11, s11_thru_corrigido=None,
                        isolamento=None, kit=None):
    """Termos de transmissão: isolamento e rastreio.

    O isolamento é medido no piso de ruído. Se ele não for muito promediado,
    ele INJETA ruído em vez de tirar diafonia — por isso é opcional e vem
    desligado por padrão.
    """
    thru = np.asarray(thru_medido, complex)
    e30 = (np.asarray(isolamento, complex) if isolamento is not None
           else np.zeros_like(thru))
    definido = (kit_cal.s21_thru(f, (kit or {}).get("thru", {"tau": 0.0}))
                if kit else np.ones_like(thru))
    e10e32 = (thru - e30) / definido
    return dict(e30=e30, e10e32=e10e32)


# --------------------------------------------------------------- aplicação
def corrige(termos, s11_m, s21_m=None):
    """Aplica a correção. Devolve (s11, s21)."""
    e00 = termos["e00"]
    e11 = termos["e11"]
    e10e01 = termos["e10e01"]
    d = np.asarray(s11_m, complex) - e00
    s11 = d / (e11 * d + e10e01)
    if s21_m is None or "e10e32" not in termos:
        return s11, s21_m
    e30 = termos.get("e30", 0.0)
    s21 = ((np.asarray(s21_m, complex) - e30) / termos["e10e32"]) * (1 - e11 * s11)
    return s11, s21


# ------------------------------------------------------------ interpolação
def _interpola_complexo(f_orig, v, f_novo):
    """Interpola em módulo e fase desdobrada, nunca em parte real e imaginária.

    Com 1 ns de cabo, `e10e01` dá uma volta inteira a cada 500 MHz. Interpolar
    a parte real numa grade grossa produziria ondulação de amplitude que não
    existe. Tirar a fase linear antes resolve isso.
    """
    v = np.asarray(v, complex)
    fase = np.unwrap(np.angle(v))
    # remove o atraso dominante
    p = np.polyfit(f_orig, fase, 1)
    resto = fase - np.polyval(p, f_orig)
    mag = np.interp(f_novo, f_orig, np.abs(v))
    res = np.interp(f_novo, f_orig, resto)
    return mag * np.exp(1j * (np.polyval(p, f_novo) + res))


def interpola(termos, f_novo):
    """Leva os termos de erro para outra grade. Extrapolar é proibido."""
    f = np.asarray(termos["f"], float)
    f_novo = np.asarray(f_novo, float)
    if f_novo.min() < f.min() - 1 or f_novo.max() > f.max() + 1:
        raise ValueError(
            "a banda pedida (%.3f a %.3f MHz) sai da banda calibrada "
            "(%.3f a %.3f MHz). Extrapolar calibração é pior do que não "
            "calibrar: o resultado parece plausível e está errado."
            % (f_novo.min() / 1e6, f_novo.max() / 1e6,
               f.min() / 1e6, f.max() / 1e6))
    novo = dict(f=f_novo, cond=np.interp(f_novo, f, termos.get(
        "cond", np.ones_like(f))))
    for k in ("e00", "e11", "e10e01", "e30", "e10e32"):
        if k in termos:
            novo[k] = _interpola_complexo(f, termos[k], f_novo)
    aviso = None
    if len(f_novo) > 4 * len(f):
        aviso = ("a grade nova é %.1f vezes mais densa que a da calibração; a "
                 "interpolação não inventa a resolução que a calibração não tem"
                 % (len(f_novo) / len(f)))
    novo["aviso"] = aviso
    return novo


def mistura_no_tempo(termos_ini, termos_fim, peso):
    """Interpola dois conjuntos de termos no tempo. `peso` vai de 0 a 1.

    HIPÓTESE, que a tela precisa declarar: a deriva é lenta e monótona. Se
    alguém mexeu num cabo ou trocou um conector no meio da sessão, isto é
    inválido — e é por isso que a diferença entre os dois conjuntos é medida e
    denunciada quando passa do limite.
    """
    peso = float(np.clip(peso, 0.0, 1.0))
    saida = dict(f=termos_ini["f"])
    for k in ("e00", "e11", "e10e01", "e30", "e10e32"):
        if k in termos_ini and k in termos_fim:
            a, b = termos_ini[k], termos_fim[k]
            ma, mb = np.abs(a), np.abs(b)
            pa, pb = np.unwrap(np.angle(a)), np.unwrap(np.angle(b))
            saida[k] = ((1 - peso) * ma + peso * mb) * np.exp(
                1j * ((1 - peso) * pa + peso * pb))
        elif k in termos_ini:
            saida[k] = termos_ini[k]
    return saida


def distancia(termos_a, termos_b):
    """Quanto os dois conjuntos diferem, em dB. Serve de portão do colchete."""
    out = {}
    for k in ("e00", "e11", "e10e01", "e10e32"):
        if k in termos_a and k in termos_b:
            d = np.abs(np.asarray(termos_a[k]) - np.asarray(termos_b[k]))
            ref = np.maximum(np.abs(termos_a[k]), 1e-12)
            out[k] = float(20 * np.log10(np.max(d / ref) + 1e-30))
    return out


# ------------------------------------------------------------ reverificação
def reverifica(f, termos, medidos, kit):
    """Mede o desvio dos padrões contra o ideal, com a calibração VIGENTE.

    Isto não recalcula nada e não muda dado nenhum: é um número de qualidade.
    Portão sugerido: uma carga acima de −30 dB reprova a sessão.
    """
    ideais = kit_cal.padroes(f, kit)
    r = {}
    for nome in ("aberto", "curto", "carga"):
        if nome not in medidos:
            continue
        corr, _ = corrige(termos, medidos[nome])
        ideal = np.asarray(ideais[nome], complex)
        if nome == "carga":
            with np.errstate(divide="ignore"):
                db = 20 * np.log10(np.abs(corr) + 1e-30)
            r[nome] = dict(pior_db=float(np.max(db)),
                           mediana_db=float(np.median(db)))
        else:
            erro_fase = np.degrees(np.angle(corr / ideal))
            erro_mag = 20 * np.log10(np.abs(corr) / np.abs(ideal) + 1e-30)
            r[nome] = dict(pior_fase_graus=float(np.max(np.abs(erro_fase))),
                           pior_mag_db=float(np.max(np.abs(erro_mag))))
    r["veredito"] = ("reprovado" if r.get("carga", {}).get("pior_db", -99) > -30
                     else "aprovado")
    return r


# ------------------------------------------------------------------ disco
def salva(nome, termos, kit, meta=None):
    garante(CALS)
    npz = os.path.join(CALS, "%s.npz" % nome)
    chaves = {k: np.asarray(termos[k]) for k in
              ("f", "e00", "e11", "e10e01", "e30", "e10e32", "cond")
              if k in termos}
    np.savez_compressed(npz, **chaves)
    with open(npz, "rb") as fh:
        sha = hashlib.sha256(fh.read()).hexdigest()
    d = dict(nome=nome, criado_em=time.strftime("%Y-%m-%dT%H:%M:%S"),
             kit=kit, arquivo=os.path.basename(npz), sha256=sha,
             f_inicio_hz=float(termos["f"][0]), f_fim_hz=float(termos["f"][-1]),
             n=int(len(termos["f"])),
             cond_max=float(np.max(termos.get("cond", [1]))),
             tipo=("resposta_melhorada" if "e10e32" in termos else "1porta"),
             **(meta or {}))
    with open(os.path.join(CALS, "%s.json" % nome), "w", encoding="utf-8") as fh:
        json.dump(d, fh, ensure_ascii=False, indent=2)
    return d


def carrega(nome):
    with open(os.path.join(CALS, "%s.json" % nome), encoding="utf-8") as fh:
        meta = json.load(fh)
    z = np.load(os.path.join(CALS, meta["arquivo"]))
    termos = {k: z[k] for k in z.files}
    return termos, meta


def lista():
    if not os.path.isdir(CALS):
        return []
    return sorted(a[:-5] for a in os.listdir(CALS) if a.endswith(".json"))
