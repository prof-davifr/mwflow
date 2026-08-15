#!/usr/bin/env python3
"""Extração de f_res por AJUSTE, não por argmax.

CÓPIA DELIBERADA, COM ATRIBUIÇÃO
--------------------------------
Origem: `Setup VNA Fluido em Movimento/sensor-etanol/src/sensor_etanol/ajuste.py`
        commit cac3b63, 2026-07-28.
As funções `_modelo` e `ajusta` são idênticas à origem. Só saíram daqui o
`from sensor_etanol.caminhos import RUNS`, o `do_caso` e o `main`, que dependem
da árvore `runs/` daquele projeto.

Por que copiar em vez de importar — três motivos, do mais forte ao mais fraco:

1. Precedente escrito da casa. `revisao-sensor-microondas/src/extrai_fq.py` já
   fez a mesma cópia e explica: o monorepo não tem gerenciador de pacotes e o
   import cruzado entre projetos é frágil.
2. A origem não é importável isolada: ela faz `from sensor_etanol.caminhos
   import RUNS` no escopo do módulo, e isso arrasta o pacote inteiro e fixa um
   caminho que não existe aqui.
3. O MWFlow é um instrumento. Ele tem de continuar medindo se o projeto vizinho
   for movido ou arquivado. Um aplicativo de medida que troca de estimador
   porque alguém editou outra pasta é um risco de reprodutibilidade.

O teste `testes/teste_ajuste_vendorizado.py` importa a origem por caminho
explícito quando ela existe e exige concordância até 1e-12. Se a origem sumir,
o teste é pulado. É isso que torna a cópia segura.

POR QUE NÃO ARGMAX (o argumento da origem, preservado)
------------------------------------------------------
Este ressoador tem Q ~ 9 (FWHM ~ 175 MHz). O topo do pico e' quase plano: 0,5
MHz fora do apice o |S21| cai 13 ppm. O `argmax` sobre a grade fina fica entao
dominado por ruido numerico — duas corridas da MESMA configuracao dao f_res
diferindo 0,3-0,4 MHz. Os deslocamentos que o sensor precisa medir sao de 2,7 a
12 MHz, ou seja o ruido do estimador chegava a 15 % do sinal.

O ajuste usa a curva INTEIRA em vez do ponto mais alto, e o S21 COMPLEXO em vez
do modulo — a fase varia rapido na ressonancia mesmo quando o modulo e' chato, e
e' ela que fixa f_res com precisao.

Modelo de um polo com fundo (acoplamento por gaps serie):

    S21(f) = C + A / (1 + 2j Q (f - f0) / f0)

com C e A complexos. Devolve f0, Q e o residuo rms.

Viés de estimador: Petersan & Anlage, J. Appl. Phys. 84, 3392 (1998).
"""

import numpy as np
from scipy.optimize import least_squares

BANDA_PADRAO = (1.30e9, 2.00e9)


def _modelo(p, f):
    cr, ci, ar, ai, Q, f0 = p
    return (cr + 1j * ci) + (ar + 1j * ai) / (1 + 2j * Q * (f - f0) / f0)


def ajusta(f, s21, banda=BANDA_PADRAO):
    """Ajusta o modelo de 1 polo. Devolve dict(f0, Q, rms, il_db).

    `banda` restringe a janela; o argmax so entra como CHUTE INICIAL."""
    sel = (f >= banda[0]) & (f <= banda[1])
    if sel.sum() < 20:
        return None
    ff, ss = f[sel], s21[sel]
    i0 = int(np.argmax(np.abs(ss)))
    f0_0 = ff[i0]
    # Q inicial pela meia-potencia (grosseiro, so p/ semear)
    pk = np.abs(ss[i0])
    meia = pk / np.sqrt(2)
    esq = ff[:i0][np.abs(ss[:i0]) < meia]
    dire = ff[i0:][np.abs(ss[i0:]) < meia]
    fw = (dire[0] - esq[-1]) if len(esq) and len(dire) else f0_0 / 10.0
    Q0 = max(f0_0 / max(fw, 1e6), 2.0)
    A0 = ss[i0]
    p0 = [0.0, 0.0, A0.real, A0.imag, Q0, f0_0]

    def res(p):
        d = _modelo(p, ff) - ss
        return np.concatenate([d.real, d.imag])

    try:
        r = least_squares(res, p0, method="lm", max_nfev=20000)
    except Exception:
        return None
    cr, ci, ar, ai, Q, f0 = r.x
    if not (banda[0] < f0 < banda[1]) or Q <= 0:
        return None
    rms = float(np.sqrt(np.mean(res(r.x) ** 2)))
    # |S21| do modelo no pico ajustado
    il = float(20 * np.log10(np.abs(_modelo(r.x, np.array([f0])))[0]))
    return dict(f0=float(f0), Q=float(abs(Q)), rms=rms, il_db=il)
