#!/usr/bin/env python3
"""Curva de calibração do sensor: ajuste, sensibilidade, limite de detecção e
previsão inversa.

CONVENÇÃO HERDADA. A sensibilidade **nunca** é citada sozinha: ela vem sempre
com a faixa em que foi ajustada, porque o valor muda com a faixa. É a regra do
`sensor_etanol/sensibilidade.py`, e ela é obrigatória aqui.

    S   = inclinação, em unidade de Y por unidade de X
    LOD = 3·σ_y / |S|          (a fórmula de postproc_etanol.sens_lod)
    LOQ = 10·σ_y / |S|

DE ONDE VEM σ_y — E POR QUE ISSO IMPORTA. O `sensibilidade.py` usa
`PRECISAO_MHZ = 1.0`, uma precisão **suposta**. Com o MWFlow medindo N
varreduras do mesmo dispositivo parado, σ passa a ser **medido**. As duas vias
convivem aqui, e o campo `sigma_origem` diz qual foi usada, porque trocar de
via muda o limite de detecção publicado.

X E COVARIÁVEL SÃO GENÉRICOS. Este módulo não sabe o que é o X nem o que é a
covariável: ele recebe os dois nomes e as duas unidades e os repete no texto.
O X foi a concentração de um analito e a covariável foi a temperatura enquanto
existiu um experimento só; qualquer grandeza serve, e o operador digita qual.
O tipo de ajuste `covariavel` é o antigo `termico`, e o nome velho continua
aceito na entrada para as curvas já gravadas não mudarem de sentido.
"""

import json
import time

import numpy as np

TIPOS = ("linear", "poli2", "poli3", "covariavel")
GRAU = {"linear": 1, "poli2": 2, "poli3": 3}
#: nome antigo → nome de hoje. A tabela `ajustes_curva` guarda o texto do tipo.
APELIDOS = {"termico": "covariavel"}


def canon(tipo):
    """Nome canônico do tipo de ajuste."""
    return APELIDOS.get(tipo, tipo)


def _mascara(x, faixa):
    x = np.asarray(x, float)
    if not faixa:
        return np.ones_like(x, bool)
    lo, hi = faixa
    m = np.ones_like(x, bool)
    if lo is not None:
        m &= x >= lo
    if hi is not None:
        m &= x <= hi
    return m


def ajusta_curva(x, y, tipo="linear", faixa=None, cov_valores=None,
                 sigma_y=None, sigma_origem="assumida", unidade_x="",
                 unidade_y="", nome_cov="covariável", unidade_cov=""):
    """Ajusta e devolve tudo que a tela precisa mostrar.

    `tipo="covariavel"` ajusta `y = a0 + a1·x + a2·(C − C_ref)`, onde C é a
    covariável registrada em cada ponto. O coeficiente `a2` **é** a curva de
    correção pedida pelo ROADMAP §F3, em unidade de Y por unidade da
    covariável. Dividido por `a1` ele vira "quanto de X uma unidade da
    covariável imita" — o número que justifica registrar a covariável, medido
    em vez de suposto. Com a covariável em °C, é o coeficiente térmico.
    """
    tipo = canon(tipo)
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    m = _mascara(x, faixa) & np.isfinite(x) & np.isfinite(y)
    if cov_valores is not None:
        C = np.asarray(cov_valores, float)
    else:
        C = None

    n = int(m.sum())
    if tipo == "covariavel":
        if C is None or not np.isfinite(C[m]).all():
            return dict(erro="o ajuste com covariável exige %s em todos os "
                             "pontos" % nome_cov)
        if n < 4:
            return dict(erro="o ajuste com covariável precisa de 4 pontos ou mais")
    elif n < GRAU.get(tipo, 1) + 2:
        return dict(erro="poucos pontos na faixa: %d" % n)

    if tipo == "covariavel":
        Cref = float(np.mean(C[m]))
        A = np.column_stack([np.ones(n), x[m], C[m] - Cref])
        coefs, *_ = np.linalg.lstsq(A, y[m], rcond=None)
        prev = A @ coefs
        p = 3
        cov = _cov_lstsq(A, y[m], prev, p)
        sens = float(coefs[1])
        extra = dict(cov_ref=Cref, coef_cov=float(coefs[2]))
    else:
        g = GRAU[tipo]
        coefs, cov = np.polyfit(x[m], y[m], g, cov=True)
        prev = np.polyval(coefs, x[m])
        p = g + 1
        # a sensibilidade de um polinômio varia com x; cita-se a do centro
        d = np.polyder(coefs)
        sens = float(np.polyval(d, np.mean(x[m])))
        extra = {}

    res = y[m] - prev
    ss_res = float(np.sum(res ** 2))
    ss_tot = float(np.sum((y[m] - np.mean(y[m])) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    r2_aj = (1 - (1 - r2) * (n - 1) / (n - p)) if n > p else float("nan")
    s_yx = float(np.sqrt(ss_res / (n - p))) if n > p else float("nan")

    if sigma_y is None or not np.isfinite(sigma_y):
        sigma_y = s_yx
        sigma_origem = "residuo"
    lod = 3.0 * sigma_y / abs(sens) if sens else float("inf")
    loq = 10.0 * sigma_y / abs(sens) if sens else float("inf")

    return dict(
        tipo=tipo, grau=GRAU.get(tipo, 1), n=n,
        faixa=[None if faixa is None else faixa[0],
               None if faixa is None else faixa[1]],
        coefs=[float(c) for c in np.atleast_1d(coefs)],
        cov=[[float(v) for v in linha] for linha in np.atleast_2d(cov)],
        # posições dos pontos que entraram, na ordem em que vieram. Sem elas
        # quem chamou não consegue alinhar a ordem de execução e a covariável
        # com os resíduos quando uma faixa corta pontos fora.
        indices=[int(i) for i in np.flatnonzero(m)],
        r2=float(r2), r2_aj=float(r2_aj), s_yx=s_yx,
        sensibilidade=sens,
        unidade_sens=("%s/%s" % (unidade_y or "y", unidade_x or "x")),
        nome_cov=nome_cov, unidade_cov=unidade_cov,
        sigma_y=float(sigma_y), sigma_origem=sigma_origem,
        lod=float(lod), loq=float(loq),
        x=[float(v) for v in x[m]], y=[float(v) for v in y[m]],
        residuos=[float(v) for v in res],
        criado_em=time.strftime("%Y-%m-%dT%H:%M:%S"), **extra)


def _cov_lstsq(A, y, prev, p):
    n = len(y)
    if n <= p:
        return np.full((p, p), np.nan)
    s2 = float(np.sum((y - prev) ** 2) / (n - p))
    try:
        return s2 * np.linalg.inv(A.T @ A)
    except np.linalg.LinAlgError:
        return np.full((p, p), np.nan)


def curva_em(ajuste, x):
    """Valor previsto de Y. Aceita escalar ou vetor."""
    x = np.asarray(x, float)
    c = np.array(ajuste["coefs"], float)
    if canon(ajuste["tipo"]) == "covariavel":
        return c[0] + c[1] * x
    return np.polyval(c, x)


# ------------------------------------------------------------- previsão inversa
def inversa(ajuste, y_medido, m=1, cov_valor=None, confianca=0.95):
    """Estima X a partir de uma leitura de Y, com incerteza.

    Recusa em vez de inventar quando:

    - o Y medido está fora da faixa de Y calibrada (isso é extrapolação);
    - a curva não é monótona ali, e a inversa não é única;
    - a inclinação não é distinguível de zero.

    Uma previsão bonita fora da faixa é pior do que uma recusa.
    """
    from scipy import stats

    xs = np.array(ajuste["x"], float)
    ys = np.array(ajuste["y"], float)
    n = ajuste["n"]
    if n < 4:
        return dict(erro="a curva tem menos de 4 pontos")

    y_lo, y_hi = float(np.min(ys)), float(np.max(ys))
    folga = 0.02 * (y_hi - y_lo)
    if not (y_lo - folga <= y_medido <= y_hi + folga):
        return dict(erro="leitura fora da faixa calibrada de Y (%.4g a %.4g)"
                    % (y_lo, y_hi))

    c = np.array(ajuste["coefs"], float)
    tipo = canon(ajuste["tipo"])

    if tipo in ("linear", "covariavel"):
        if tipo == "covariavel":
            a0, a1, a2 = c
            if cov_valor is None:
                return dict(erro="este ajuste usa %s; informe o valor dela"
                            % ajuste.get("nome_cov", "uma covariável"))
            alvo = y_medido - a2 * (cov_valor - ajuste["cov_ref"])
        else:
            a1, a0 = c[0], c[1]
            alvo = y_medido
        if not np.isfinite(a1) or a1 == 0:
            return dict(erro="inclinação nula: a curva não inverte")
        # significância da inclinação
        cov = np.array(ajuste["cov"], float)
        i1 = 1 if tipo == "covariavel" else 0
        se_a1 = float(np.sqrt(cov[i1][i1])) if np.isfinite(cov[i1][i1]) else np.nan
        if np.isfinite(se_a1) and se_a1 > 0:
            t_obs = abs(a1) / se_a1
            if t_obs < stats.t.ppf(0.975, max(1, n - 2)):
                return dict(erro="a inclinação não difere de zero a 95 %")

        x_est = (alvo - a0) / a1
        s_yx = ajuste["s_yx"]
        xb = float(np.mean(xs))
        sxx = float(np.sum((xs - xb) ** 2))
        if sxx <= 0:
            return dict(erro="todos os X são iguais")
        u = (s_yx / abs(a1)) * np.sqrt(1.0 / max(1, m) + 1.0 / n
                                       + (x_est - xb) ** 2 / sxx)
        t = stats.t.ppf(0.5 + confianca / 2, max(1, n - 2))
        return dict(x=float(x_est), u=float(u), meia_largura=float(t * u),
                    confianca=confianca, metodo="calibração clássica")

    # polinômio: raízes reais dentro da faixa, e incerteza por Monte Carlo
    raizes = np.roots(np.array(c, float) - np.array([0] * (len(c) - 1) + [y_medido]))
    x_lo, x_hi = float(np.min(xs)), float(np.max(xs))
    boas = [float(r.real) for r in raizes
            if abs(r.imag) < 1e-9 and x_lo <= r.real <= x_hi]
    if not boas:
        return dict(erro="nenhuma solução dentro da faixa calibrada")
    if len(boas) > 1:
        return dict(erro="a curva não é monótona aqui: %d soluções (%s)"
                    % (len(boas), ", ".join("%.4g" % b for b in boas)))
    x_est = boas[0]

    cov = np.array(ajuste["cov"], float)
    amostras = []
    if np.isfinite(cov).all():
        rng = np.random.default_rng(12345)
        cs = rng.multivariate_normal(c, cov, size=2000)
        ruido = rng.normal(0, ajuste["s_yx"] / np.sqrt(max(1, m)), size=2000)
        for k in range(2000):
            r = np.roots(cs[k] - np.array([0] * (len(c) - 1) + [y_medido + ruido[k]]))
            b = [rr.real for rr in r if abs(rr.imag) < 1e-9 and x_lo <= rr.real <= x_hi]
            if len(b) == 1:
                amostras.append(b[0])
    if len(amostras) > 100:
        lo, hi = np.percentile(amostras, [2.5, 97.5])
        return dict(x=x_est, u=float((hi - lo) / 3.92),
                    meia_largura=float((hi - lo) / 2), confianca=0.95,
                    metodo="Monte Carlo sobre a covariância")
    return dict(x=x_est, u=float("nan"), meia_largura=float("nan"),
                confianca=0.95, metodo="raiz sem incerteza")


# ------------------------------------------------------------ varredura de R²
def varredura_r2(freqs, matriz_y, x):
    """R² da regressão de Y contra X, frequência a frequência.

    `matriz_y` tem uma linha por ponto de calibração e uma coluna por
    frequência. Devolve o R² em cada frequência e a melhor delas. É o modo de
    descobrir ONDE o sensor responde, em vez de adivinhar — a ideia vem do
    waveCal-END.
    """
    from scipy import stats

    x = np.asarray(x, float)
    Y = np.asarray(matriz_y, float)
    if Y.ndim != 2 or Y.shape[0] != len(x):
        return dict(erro="a matriz precisa de uma linha por ponto de calibração")
    n_f = Y.shape[1]
    r2 = np.full(n_f, np.nan)
    incl = np.full(n_f, np.nan)
    for j in range(n_f):
        col = Y[:, j]
        bom = np.isfinite(col)
        if bom.sum() < 3:
            continue
        r = stats.linregress(x[bom], col[bom])
        r2[j] = r.rvalue ** 2
        incl[j] = r.slope
    if np.all(np.isnan(r2)):
        return dict(erro="não houve nenhuma frequência ajustável")
    j = int(np.nanargmax(r2))
    return dict(freqs=[float(v) for v in freqs],
                r2=[None if not np.isfinite(v) else float(v) for v in r2],
                inclinacao=[None if not np.isfinite(v) else float(v) for v in incl],
                melhor_hz=float(freqs[j]), melhor_r2=float(r2[j]),
                melhor_inclinacao=float(incl[j]))


# ---------------------------------------------------------------- planejamento
def planeja_serie(x_min, x_max, passo, replicas=1, referencia=None,
                  intercalar_a_cada=3, semente=None):
    """Lista de trabalho em ordem aleatória, com retornos intercalados.

    É o passo 4 do ROADMAP §F3. A ordem aleatória é o que permite separar a
    resposta ao X da deriva no tempo; os retornos ao ponto de referência
    são o que torna a deriva visível. A semente fica guardada, senão a série
    não é reproduzível.
    """
    if semente is None:
        semente = int(time.time()) % 100000
    rng = np.random.default_rng(semente)
    niveis = np.round(np.arange(x_min, x_max + passo / 2, passo), 6)
    lista = []
    for r in range(replicas):
        rep = chr(ord("A") + r)
        ordem = rng.permutation(niveis)
        for k, v in enumerate(ordem):
            lista.append(dict(x=float(v), replica=rep))
            if referencia is not None and (k + 1) % intercalar_a_cada == 0:
                lista.append(dict(x=float(referencia), replica=rep + "-ref"))
    for i, item in enumerate(lista):
        item["ordem_sorteada"] = i + 1
    return dict(semente=int(semente), n=len(lista), itens=lista)


def texto_resumo(a, unidade_x="", unidade_y=""):
    """A frase que a tela mostra. A faixa nunca sai do lado da sensibilidade."""
    if a.get("erro"):
        return a["erro"]
    fx = a.get("faixa") or [None, None]
    faixa = ("faixa %s a %s %s" % (_g(fx[0]), _g(fx[1]), unidade_x)
             if fx[0] is not None or fx[1] is not None else "faixa completa")
    l1 = ("S = %s %s/%s  (%s, n = %d, R² = %s)"
          % (_g(a["sensibilidade"]), unidade_y or "y", unidade_x or "x",
             faixa, a["n"], _g(a["r2"], 4)))
    origem = {"medida": "medido", "assumida": "suposto",
              "residuo": "do resíduo do ajuste"}.get(a["sigma_origem"],
                                                     a["sigma_origem"])
    l2 = ("LOD = %s %s  (3σ, σ = %s %s %s)"
          % (_g(a["lod"]), unidade_x, _g(a["sigma_y"]), unidade_y, origem))
    return l1 + "\n" + l2


def _g(v, casas=4):
    if v is None or not np.isfinite(v):
        return "—"
    return ("%." + str(casas) + "g") % v
