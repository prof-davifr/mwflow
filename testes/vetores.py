#!/usr/bin/env python3
"""Gera os vetores de referência que o núcleo em JavaScript tem de reproduzir.

    python3 -m testes.vetores
    node testes/paridade.mjs

POR QUE ISTO EXISTE. O MWFlow tem duas implementações do mesmo instrumento: a
de Python, que produziu os números já medidos nesta bancada, e a de JavaScript,
que roda no navegador de quem baixar a página. Duas implementações que
discordam são pior do que uma só — o resultado passa a depender de onde a
medida foi feita, e isso não se descobre olhando um gráfico.

A REGRA. O Python é a verdade. Este arquivo despeja entradas e saídas dele; o
`paridade.mjs` roda os mesmos casos no núcleo em JavaScript e exige
concordância. Quando os dois discordarem, quem está errado é o JavaScript.

O que NÃO dá para exigir bit a bit, e por quê:

- O otimizador do ajuste de 1 polo. O Python usa o lmdif do MINPACK e o
  JavaScript usa um Levenberg-Marquardt próprio. Os dois caem no mesmo mínimo;
  o que difere é onde cada um decide parar dentro de um vale plano. Por isso a
  comparação é dupla: o CUSTO tem de bater em 1e-9 relativo (é ele que define o
  mínimo) e f_res tem de bater em 1 kHz — mil vezes abaixo do menor sinal que
  este sensor precisa medir, e trezentas vezes abaixo do ruído do estimador que
  o ajuste substituiu.
- O Monte Carlo da previsão inversa. O gerador do numpy não é o do navegador. A
  incerteza sai com alguns décimos de por cento de diferença, e o campo
  `metodo` da resposta diz qual ramo produziu o número.
- A ordem sorteada do planejamento da série, pelo mesmo motivo.
"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mwflow import armazenamento as az       # noqa: E402
from mwflow import curva as cv               # noqa: E402
from mwflow import kit_cal, solt             # noqa: E402
from mwflow.ajuste import ajusta             # noqa: E402
from mwflow.vna import protocolo as p        # noqa: E402
from mwflow.vna.simulador import abre_simulado  # noqa: E402

SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_vetores.json")


def cx(z):
    z = np.asarray(z)
    return dict(re=np.real(z).tolist(), im=np.imag(z).tolist())


def limpa(o):
    """NaN e infinito viram `null`.

    O `json` do Python escreve `NaN` cru, que o `JSON.parse` do navegador
    recusa. Trocar por `null` é o que o servidor já faz em `_limpa_json`; o
    lado JavaScript trata `null` como "não comparável", e o caso do `fwd0`
    nulo tem um teste próprio, que exige NaN de verdade.
    """
    import math
    if isinstance(o, dict):
        return {k: limpa(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [limpa(v) for v in o]
    if isinstance(o, (float, np.floating)):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, (int, np.integer)):
        return int(o)
    if isinstance(o, np.ndarray):
        return limpa(o.tolist())
    return o


def varre(dut, pontos=401, banda=(1.30e9, 2.00e9), **kw):
    vna = abre_simulado(dut=dut, turbo=True, deriva=False, **kw)
    vna.define_varredura(banda[0], banda[1], pontos)
    f, s11, s21 = vna.varre()
    vna.fecha()
    return f, s11, s21


def bloco_fifo():
    """Um bloco cru da FIFO, com um registro de referência perdida.

    O caso do `fwd0` nulo é o que separa um driver honesto de um que estoura:
    ali o ponto tem de sair NaN, e não infinito nem zero.
    """
    n = 5
    r = np.zeros(n, dtype=p.DTYPE_FIFO)
    r["fwd_re"] = [1000000, -500000, 0, 7, 123456]
    r["fwd_im"] = [0, 250000, 0, -3, -654321]
    r["rev0_re"] = [20000, -1000, 55, 1, -9]
    r["rev0_im"] = [-30000, 4000, -55, 2, 8]
    r["rev1_re"] = [900000, 12345, 1, -4, 77]
    r["rev1_im"] = [10, -6789, -1, 5, -77]
    r["idx"] = [0, 1, 2, 3, 4]
    bruto = r.tobytes()
    idx, s11, s21 = p.analisa_fifo(bruto)
    return dict(bytes=list(bruto), idx=idx.tolist(), s11=cx(s11), s21=cx(s21))


def main():
    d = {}

    # ---------------------------------------------------------------- num
    x = np.array([0., 1., 2., 3., 4., 5., 6.])
    y = np.array([1.2, 2.9, 5.1, 6.8, 9.2, 11.1, 12.8])
    c1, v1 = np.polyfit(x, y, 1, cov=True)
    c2, v2 = np.polyfit(x, y, 2, cov=True)
    f9 = np.linspace(1e9, 2e9, 9)
    fase = np.angle(np.exp(-2j * np.pi * f9 * 3e-9))
    A = np.array([[1 + 0j, 0.5 - 0.2j, -1j],
                  [1, -0.3 + 0.9j, 2 + 0j],
                  [1, 0.02 + 0.01j, 0.4 - 0.7j]])
    d["num"] = dict(
        x=x.tolist(), y=y.tolist(),
        polyfit1=c1.tolist(), cov1=v1.tolist(),
        polyfit2=c2.tolist(), cov2=v2.tolist(),
        f=f9.tolist(), fase=fase.tolist(),
        unwrap=np.unwrap(fase).tolist(),
        gradiente=np.gradient(np.unwrap(fase), f9).tolist(),
        matriz=[[[v.real, v.imag] for v in linha] for linha in A],
        cond=float(np.linalg.cond(A)),
        raizes=sorted(float(r.real) for r in np.roots([2., -3., -3., 2.])
                      if abs(r.imag) < 1e-9),
    )
    from scipy import stats
    d["num"]["t_ppf"] = [float(stats.t.ppf(0.975, 5)),
                         float(stats.t.ppf(0.975, 40)),
                         float(stats.t.ppf(0.975, 3))]

    # ----------------------------------------------------------- protocolo
    d["fifo"] = bloco_fifo()
    d["protocolo"] = dict(
        passo=[p.passo_de(1.30e9, 2.00e9, 401), p.passo_de(50e6, 3e9, 1024),
               p.passo_de(1e9, 1e9, 1)],
        cmd_varredura=list(p.cmd_varredura(1.30e9, 1750000, 401, 2)),
        pontos_max=p.PONTOS_MAX,
    )

    # -------------------------------------------------------------- ajuste
    d["ajuste"] = {}
    for rot, kw in (("ideal", dict(ideal=True)), ("real", dict(ideal=False))):
        f, s11, s21 = varre("ressoador", **kw)
        r = ajusta(f, s21, (1.30e9, 2.00e9))
        # o custo é o que define o mínimo; ele tem de bater bem mais apertado
        # do que os parâmetros dentro de um vale plano
        d["ajuste"][rot] = dict(f=f.tolist(), s21=cx(s21), res=r,
                                custo=float(r["rms"] ** 2 * 2 * len(f)))

    # ---------------------------------------------------------------- SOLT
    f = np.linspace(1.30e9, 2.00e9, 201)
    kit = kit_cal.KITS_EMBUTIDOS["sma_generico"]
    med = {}
    for nome in ("aberto", "curto", "carga", "thru"):
        vna = abre_simulado(dut=nome, turbo=True, deriva=False, semente=11)
        vna.define_varredura(1.30e9, 2.00e9, 201)
        _, a, b = vna.varre()
        vna.fecha()
        med[nome] = (a, b)
    t = solt.resolve_uma_porta(f, {k: med[k][0] for k in
                                   ("aberto", "curto", "carga")}, kit)
    t.update(solt.resolve_transmissao(f, med["thru"][1], t["e11"], kit=kit))
    c11, c21 = solt.corrige(t, med["aberto"][0], med["thru"][1])
    fn = np.linspace(1.35e9, 1.95e9, 101)
    ti = solt.interpola(t, fn)
    d["solt"] = dict(
        f=f.tolist(), kit=kit,
        medidos={k: dict(s11=cx(v[0]), s21=cx(v[1])) for k, v in med.items()},
        padroes={k: cx(v) for k, v in kit_cal.padroes(f, kit).items()},
        e00=cx(t["e00"]), e11=cx(t["e11"]), e10e01=cx(t["e10e01"]),
        e10e32=cx(t["e10e32"]), cond=t["cond"].tolist(),
        corr11=cx(c11), corr21=cx(c21),
        fn=fn.tolist(), int_e00=cx(ti["e00"]), int_e10e01=cx(ti["e10e01"]),
        reverifica=solt.reverifica(f, t, {k: med[k][0] for k in
                                          ("aberto", "curto", "carga")}, kit),
    )

    # --------------------------------------------------------------- curva
    rng = np.random.default_rng(3)
    xc = np.array([0., 2., 4., 6., 8., 10., 12., 14.])
    T = np.array([22.1, 22.4, 22.0, 23.1, 22.8, 22.2, 23.4, 22.9])
    yc = (1500.0 - 0.85 * xc + 0.012 * xc ** 2 + 0.05 * (T - 22.5)
          + rng.normal(0, 0.03, len(xc)))
    lin = cv.ajusta_curva(xc, yc, "linear", sigma_y=0.05, sigma_origem="medida",
                          unidade_x="%vol", unidade_y="MHz")
    p2 = cv.ajusta_curva(xc, yc, "poli2", unidade_x="%vol", unidade_y="MHz")
    te = cv.ajusta_curva(xc, yc, "covariavel", cov_valores=T, unidade_x="%vol",
                         unidade_y="MHz", nome_cov="temperatura",
                         unidade_cov="°C")
    fx = cv.ajusta_curva(xc, yc, "linear", faixa=(2.0, 12.0), unidade_x="%vol",
                         unidade_y="MHz")
    freqs = np.linspace(1.5e9, 1.6e9, 25)
    Y = np.array([1500 - 0.9 * v + 0.001 * np.arange(25) + rng.normal(0, 0.02, 25)
                  for v in xc])
    d["curva"] = dict(
        x=xc.tolist(), y=yc.tolist(), t=T.tolist(),
        linear=lin, poli2=p2, covariavel=te, faixado=fx,
        inv_linear=cv.inversa(lin, float(yc[3]), m=5),
        inv_poli2=cv.inversa(p2, float(yc[3]), m=5),
        inv_fora=cv.inversa(lin, 2000.0),
        resumo=cv.texto_resumo(lin, "%vol", "MHz"),
        freqs=freqs.tolist(), matriz=Y.tolist(),
        r2=cv.varredura_r2(freqs, Y, xc),
    )

    # ------------------------------------------------------------ arquivos
    fa = np.array([50e6, 1.2345e9, 3e9, 6.29e9])
    a11 = np.array([0.5 + 0.25j, -1e-7 + 2.5e-8j, 0.0 + 0.0j, -0.999 + 0.001j])
    a21 = np.array([1e-3 - 2e-3j, 0.9999 + 0.0001j, -1.5e-12 + 0j, 0.3 + 0.4j])
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        csv = os.path.join(tmp, "a.csv")
        s2p = os.path.join(tmp, "a.s2p")
        az.escreve_csv_litevna(csv, fa, a11, a21)
        az.escreve_touchstone(s2p, fa, a11, a21,
                              dict(sessao="teste", seq=7, aparelho="simulado"))
        # `newline=""` desliga a tradução de fim de linha na leitura. Sem ele o
        # CRLF do formato nativo viraria LF aqui dentro, e o teste cobraria do
        # JavaScript um arquivo que o LiteVNA nunca escreveu.
        with open(csv, encoding="ascii", newline="") as fh:
            texto_csv = fh.read()
        with open(s2p, encoding="ascii") as fh:
            texto_s2p = fh.read()
    d["arquivos"] = dict(f=fa.tolist(), s11=cx(a11), s21=cx(a21),
                         csv=texto_csv, s2p=texto_s2p)

    with open(SAIDA, "w", encoding="utf-8") as fh:
        json.dump(limpa(d), fh)
    print("vetores de referência em %s (%.0f kB)"
          % (SAIDA, os.path.getsize(SAIDA) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
