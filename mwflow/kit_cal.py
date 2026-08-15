#!/usr/bin/env python3
"""Modelos dos padrões de calibração.

Um padrão real não é um aberto ideal. Ele é uma linha de transmissão curta e
com perda, terminada em algo quase ideal. Ignorar isso é o erro mais comum de
uma calibração caseira: um aberto SMA típico tem 50 fF de capacitância de
franja, o que já dá **−5,4° de fase em 3 GHz** e −10,8° em 6 GHz. Para medir o
Q de um ressoador isso não é detalhe.

O modelo aqui é o definicional da Keysight/HP, para qualquer definição de kit
publicada poder ser digitada direto.

LINHA DE OFFSET, com atraso `tau` (s, de ida), impedância `z_off` e perda
`perda` (ohm/s, especificada em 1 GHz):

    alfa_l = perda * tau / (2 * z_off) * sqrt(f / 1e9)
    beta_l = 2*pi*f*tau + alfa_l
    gama_l = alfa_l + j*beta_l

O termo de fase igual a `alfa_l` faz parte do modelo — ele é o efeito pelicular,
e omiti-lo é um defeito clássico.

TERMINAÇÕES:

- aberto: C(f) = C0 + C1 f + C2 f² + C3 f³, e Gama = (1 - jwC Z0)/(1 + jwC Z0)
- curto:  L(f) = L0 + L1 f + L2 f² + L3 f³, e Gama = (jwL - Z0)/(jwL + Z0)
- carga:  Gama = 0, ou um arquivo .s1p medido

AVISO. Os valores de `sma_generico` são um CHUTE razoável, não uma
caracterização. Um kit de verdade traz os coeficientes dele; use-os. O MWFlow
guarda o kit POR VALOR dentro de cada conjunto de calibração, para uma
calibração antiga continuar interpretável mesmo que o arquivo do kit mude.
"""

import json
import os

import numpy as np

from mwflow.caminhos import CALS, garante

Z0 = 50.0

KITS_EMBUTIDOS = {
    "ideal": {
        "nome": "ideal",
        "descricao": "padrões perfeitos. Serve para teste sintético, não para bancada.",
        "aberto": {"tau": 0.0, "perda": 0.0, "z_off": 50.0, "c": [0, 0, 0, 0]},
        "curto": {"tau": 0.0, "perda": 0.0, "z_off": 50.0, "l": [0, 0, 0, 0]},
        "carga": {"tau": 0.0, "perda": 0.0, "z_off": 50.0, "gama": 0.0},
        "thru": {"tau": 0.0, "perda_db": 0.0},
    },
    "sma_generico": {
        "nome": "sma_generico",
        "descricao": ("valores plausíveis de um kit SMA comum. SUBSTITUA pelos "
                      "coeficientes do seu kit assim que os tiver."),
        # C em 1e-15, 1e-27, 1e-36, 1e-45 F; L em 1e-12, 1e-24, 1e-33, 1e-42 H
        "aberto": {"tau": 29.24e-12, "perda": 2.2e9, "z_off": 50.0,
                   "c": [50.0, -310.0, 23.2, -0.16]},
        "curto": {"tau": 31.79e-12, "perda": 2.36e9, "z_off": 50.0,
                  "l": [2.077, -108.5, 2.171, -0.01]},
        "carga": {"tau": 0.0, "perda": 0.0, "z_off": 50.0, "gama": 0.0},
        "thru": {"tau": 0.0, "perda_db": 0.0},
    },
}

ESCALA_C = [1e-15, 1e-27, 1e-36, 1e-45]
ESCALA_L = [1e-12, 1e-24, 1e-33, 1e-42]


def _gama_l(f, tau, perda, z_off):
    f = np.asarray(f, float)
    if tau == 0 and perda == 0:
        return np.zeros_like(f, dtype=complex)
    alfa = (perda * tau / (2 * z_off)) * np.sqrt(np.maximum(f, 0) / 1e9)
    beta = 2 * np.pi * f * tau + alfa
    return alfa + 1j * beta


def _com_offset(f, gama_t, tau, perda, z_off):
    """Aplica a linha de offset a uma terminação."""
    gl = _gama_l(f, tau, perda, z_off)
    if abs(z_off - Z0) < 1e-12:
        return gama_t * np.exp(-2 * gl)
    g1 = (z_off - Z0) / (z_off + Z0)
    e2 = np.exp(-2 * gl)
    den = 1 - g1 ** 2 * e2
    s11 = g1 * (1 - e2) / den
    s21_2 = ((1 - g1 ** 2) * np.exp(-gl) / den) ** 2
    return s11 + s21_2 * gama_t / (1 - s11 * gama_t)


def gama_aberto(f, d):
    w = 2 * np.pi * np.asarray(f, float)
    c = sum(k * e * np.asarray(f, float) ** i
            for i, (k, e) in enumerate(zip(d["c"], ESCALA_C)))
    gt = (1 - 1j * w * c * Z0) / (1 + 1j * w * c * Z0)
    return _com_offset(f, gt, d["tau"], d["perda"], d["z_off"])


def gama_curto(f, d):
    w = 2 * np.pi * np.asarray(f, float)
    l = sum(k * e * np.asarray(f, float) ** i
            for i, (k, e) in enumerate(zip(d["l"], ESCALA_L)))
    gt = (1j * w * l - Z0) / (1j * w * l + Z0)
    return _com_offset(f, gt, d["tau"], d["perda"], d["z_off"])


def gama_carga(f, d):
    gt = np.full(np.shape(f), complex(d.get("gama", 0.0)))
    return _com_offset(f, gt, d.get("tau", 0.0), d.get("perda", 0.0),
                       d.get("z_off", Z0))


def s21_thru(f, d):
    a = 10 ** (-abs(d.get("perda_db", 0.0)) / 20.0)
    return a * np.exp(-2j * np.pi * np.asarray(f, float) * d.get("tau", 0.0))


def padroes(f, kit):
    """Reflexão verdadeira de cada padrão, na grade `f`."""
    return dict(aberto=gama_aberto(f, kit["aberto"]),
                curto=gama_curto(f, kit["curto"]),
                carga=gama_carga(f, kit["carga"]))


# ------------------------------------------------------------------ disco
def caminho_kit(nome):
    return os.path.join(CALS, "kits", "%s.json" % nome)


def salva_kit(kit):
    garante(os.path.join(CALS, "kits"))
    with open(caminho_kit(kit["nome"]), "w", encoding="utf-8") as fh:
        json.dump(kit, fh, ensure_ascii=False, indent=2)


def carrega_kit(nome):
    c = caminho_kit(nome)
    if os.path.exists(c):
        with open(c, encoding="utf-8") as fh:
            return json.load(fh)
    if nome in KITS_EMBUTIDOS:
        return json.loads(json.dumps(KITS_EMBUTIDOS[nome]))
    raise KeyError("kit desconhecido: %s" % nome)


def lista_kits():
    nomes = set(KITS_EMBUTIDOS)
    d = os.path.join(CALS, "kits")
    if os.path.isdir(d):
        for a in os.listdir(d):
            if a.endswith(".json"):
                nomes.add(a[:-5])
    return sorted(nomes)


def instala_embutidos():
    for k in KITS_EMBUTIDOS.values():
        if not os.path.exists(caminho_kit(k["nome"])):
            salva_kit(k)
