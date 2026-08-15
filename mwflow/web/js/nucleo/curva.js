/* Curva de calibração do sensor — gêmeo de `mwflow/curva.py`.
 *
 * CONVENÇÃO HERDADA. A sensibilidade **nunca** é citada sozinha: ela vem
 * sempre com a faixa em que foi ajustada, porque o valor muda com a faixa. É a
 * regra do `sensor_etanol/sensibilidade.py`, e ela é obrigatória aqui.
 *
 *     S   = inclinação, em unidade de Y por unidade de X
 *     LOD = 3·σ_y / |S|
 *     LOQ = 10·σ_y / |S|
 *
 * X E COVARIÁVEL SÃO GENÉRICOS. Este módulo não sabe o que é o X nem o que é a
 * covariável: ele recebe os dois nomes e as duas unidades e os repete no texto.
 * O tipo de ajuste `covariavel` é o antigo `termico`, e o nome velho continua
 * aceito na entrada para as curvas já gravadas não mudarem de sentido.
 *
 * DE ONDE VEM σ_y — E POR QUE ISSO IMPORTA. O `sensibilidade.py` usa uma
 * precisão **suposta** de 1 MHz. Com o MWFlow medindo N varreduras do mesmo
 * dispositivo parado, σ passa a ser **medido**. As duas vias convivem aqui, e
 * o campo `sigma_origem` diz qual foi usada, porque trocar de via muda o
 * limite de detecção publicado.
 */

"use strict";

import { ajustaPolinomio, avaliaPolinomio, cholesky, derivaPolinomio,
         embaralha, geradorComSemente, media, minimosQuadrados, normal,
         percentil, raizesReais, regressaoLinear, tPpf } from "./num.js";

export const TIPOS = ["linear", "poli2", "poli3", "covariavel"];
export const GRAU = { linear: 1, poli2: 2, poli3: 3 };
/** Nome antigo → nome de hoje. A tabela `ajustes_curva` guarda o texto do tipo. */
export const APELIDOS = { termico: "covariavel" };

/** Nome canônico do tipo de ajuste. */
export function canon(tipo) {
  return APELIDOS[tipo] || tipo;
}

function agora() {
  const d = new Date();
  const z = (v) => String(v).padStart(2, "0");
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate())
    + "T" + z(d.getHours()) + ":" + z(d.getMinutes()) + ":" + z(d.getSeconds());
}

function mascara(x, faixa) {
  return x.map((v) => {
    if (!Number.isFinite(v)) return false;
    if (!faixa) return true;
    if (faixa[0] !== null && faixa[0] !== undefined && v < faixa[0]) return false;
    if (faixa[1] !== null && faixa[1] !== undefined && v > faixa[1]) return false;
    return true;
  });
}

/**
 * Ajusta e devolve tudo que a tela precisa mostrar.
 *
 * `tipo="covariavel"` ajusta `y = a0 + a1·x + a2·(C − C_ref)`, onde C é a
 * covariável registrada em cada ponto. O coeficiente `a2` **é** a curva de
 * correção, em unidade de Y por unidade da covariável. Dividido por `a1` ele
 * vira "quanto de X uma unidade da covariável imita" — o número que justifica
 * registrar a covariável, medido em vez de suposto. Com a covariável em °C, é
 * o coeficiente térmico.
 */
export function ajustaCurva(x, y, opcoes = {}) {
  const tipo = canon(opcoes.tipo || "linear");
  const faixa = opcoes.faixa || null;
  const C = opcoes.cov_valores || null;
  const nomeCov = opcoes.nome_cov || "covariável";
  let sigmaY = opcoes.sigma_y;
  let sigmaOrigem = opcoes.sigma_origem || "assumida";

  const xs = Array.from(x, Number), ys = Array.from(y, Number);
  const m = mascara(xs, faixa).map((v, i) => v && Number.isFinite(ys[i]));
  const idx = [];
  for (let i = 0; i < m.length; i++) if (m[i]) idx.push(i);
  const n = idx.length;
  const xm = idx.map((i) => xs[i]), ym = idx.map((i) => ys[i]);

  if (tipo === "covariavel") {
    if (!C || idx.some((i) => !Number.isFinite(Number(C[i])))) {
      return { erro: "o ajuste com covariável exige " + nomeCov
        + " em todos os pontos" };
    }
    if (n < 4) {
      return { erro: "o ajuste com covariável precisa de 4 pontos ou mais" };
    }
  } else if (n < (GRAU[tipo] || 1) + 2) {
    return { erro: "poucos pontos na faixa: " + n };
  }

  let coefs, cov, prev, p, sens, extra = {};
  if (tipo === "covariavel") {
    const Tm = idx.map((i) => Number(C[i]));
    const Tref = media(Float64Array.from(Tm));
    const A = xm.map((v, k) => [1, v, Tm[k] - Tref]);
    const s = minimosQuadrados(A, ym);
    if (!s) return { erro: "o sistema do ajuste térmico é singular" };
    coefs = s.x;
    prev = A.map((linha) => linha[0] * coefs[0] + linha[1] * coefs[1]
                            + linha[2] * coefs[2]);
    p = 3;
    let ssr = 0;
    for (let i = 0; i < n; i++) ssr += (ym[i] - prev[i]) ** 2;
    const s2 = n > p ? ssr / (n - p) : NaN;
    cov = s.invAtA.map((linha) => linha.map((v) => v * s2));
    sens = coefs[1];
    extra = { cov_ref: Tref, coef_cov: coefs[2] };
  } else {
    const g = GRAU[tipo];
    const r = ajustaPolinomio(Float64Array.from(xm), Float64Array.from(ym), g);
    if (!r) return { erro: "o sistema do ajuste polinomial é singular" };
    coefs = r.coefs; cov = r.cov;
    prev = xm.map((v) => avaliaPolinomio(coefs, v));
    p = g + 1;
    // a sensibilidade de um polinômio varia com x; cita-se a do centro
    sens = avaliaPolinomio(derivaPolinomio(coefs), media(Float64Array.from(xm)));
  }

  const res = ym.map((v, i) => v - prev[i]);
  let ssRes = 0, ssTot = 0;
  const my = media(Float64Array.from(ym));
  for (let i = 0; i < n; i++) { ssRes += res[i] * res[i]; ssTot += (ym[i] - my) ** 2; }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
  const r2aj = n > p ? 1 - (1 - r2) * (n - 1) / (n - p) : NaN;
  const sYx = n > p ? Math.sqrt(ssRes / (n - p)) : NaN;

  if (sigmaY === null || sigmaY === undefined || !Number.isFinite(sigmaY)) {
    sigmaY = sYx;
    sigmaOrigem = "residuo";
  }
  const lod = sens ? 3.0 * sigmaY / Math.abs(sens) : Infinity;
  const loq = sens ? 10.0 * sigmaY / Math.abs(sens) : Infinity;

  return Object.assign({
    tipo: tipo, grau: GRAU[tipo] || 1, n: n,
    faixa: [faixa ? faixa[0] : null, faixa ? faixa[1] : null],
    // posições dos pontos que entraram, na ordem em que vieram. Sem elas quem
    // chamou não consegue alinhar a ordem de execução e a covariável com os
    // resíduos quando uma faixa corta pontos fora.
    indices: idx,
    coefs: coefs, cov: cov,
    r2: r2, r2_aj: r2aj, s_yx: sYx,
    sensibilidade: sens,
    unidade_sens: (opcoes.unidade_y || "y") + "/" + (opcoes.unidade_x || "x"),
    nome_cov: nomeCov, unidade_cov: opcoes.unidade_cov || "",
    sigma_y: sigmaY, sigma_origem: sigmaOrigem,
    lod: lod, loq: loq,
    x: xm, y: ym, residuos: res,
    criado_em: agora(),
  }, extra);
}

/** Valor previsto de Y. */
export function curvaEm(ajuste, x) {
  if (canon(ajuste.tipo) === "covariavel") {
    return ajuste.coefs[0] + ajuste.coefs[1] * x;
  }
  return avaliaPolinomio(ajuste.coefs, x);
}

// ------------------------------------------------------- previsão inversa
/**
 * Estima X a partir de uma leitura de Y, com incerteza.
 *
 * Recusa em vez de inventar quando:
 *
 * - o Y medido está fora da faixa de Y calibrada (isso é extrapolação);
 * - a curva não é monótona ali, e a inversa não é única;
 * - a inclinação não é distinguível de zero.
 *
 * Uma previsão bonita fora da faixa é pior do que uma recusa.
 */
export function inversa(ajuste, yMedido, opcoes = {}) {
  const m = opcoes.m || 1;
  const covValor = opcoes.cov_valor;
  const confianca = opcoes.confianca === undefined ? 0.95 : opcoes.confianca;
  const tipo = canon(ajuste.tipo);

  const xs = ajuste.x, ys = ajuste.y, n = ajuste.n;
  if (n < 4) return { erro: "a curva tem menos de 4 pontos" };

  const yLo = Math.min(...ys), yHi = Math.max(...ys);
  const folga = 0.02 * (yHi - yLo);
  if (!(yMedido >= yLo - folga && yMedido <= yHi + folga)) {
    return { erro: "leitura fora da faixa calibrada de Y ("
      + _g(yLo) + " a " + _g(yHi) + ")" };
  }
  const c = ajuste.coefs;

  if (tipo === "linear" || tipo === "covariavel") {
    let a1, a0, alvo;
    if (tipo === "covariavel") {
      a0 = c[0]; a1 = c[1];
      if (covValor === null || covValor === undefined) {
        return { erro: "este ajuste usa " + (ajuste.nome_cov || "uma covariável")
          + "; informe o valor dela" };
      }
      alvo = yMedido - c[2] * (covValor - ajuste.cov_ref);
    } else {
      a1 = c[0]; a0 = c[1];
      alvo = yMedido;
    }
    if (!Number.isFinite(a1) || a1 === 0) {
      return { erro: "inclinação nula: a curva não inverte" };
    }
    const i1 = tipo === "covariavel" ? 1 : 0;
    const vv = ajuste.cov[i1][i1];
    const seA1 = Number.isFinite(vv) ? Math.sqrt(vv) : NaN;
    if (Number.isFinite(seA1) && seA1 > 0) {
      if (Math.abs(a1) / seA1 < tPpf(0.975, Math.max(1, n - 2))) {
        return { erro: "a inclinação não difere de zero a 95 %" };
      }
    }
    const xEst = (alvo - a0) / a1;
    const xb = media(Float64Array.from(xs));
    let sxx = 0;
    for (const v of xs) sxx += (v - xb) * (v - xb);
    if (!(sxx > 0)) return { erro: "todos os X são iguais" };
    const u = (ajuste.s_yx / Math.abs(a1))
      * Math.sqrt(1 / Math.max(1, m) + 1 / n + (xEst - xb) ** 2 / sxx);
    const t = tPpf(0.5 + confianca / 2, Math.max(1, n - 2));
    return { x: xEst, u: u, meia_largura: t * u, confianca: confianca,
             metodo: "calibração clássica" };
  }

  // polinômio: raízes reais dentro da faixa, e incerteza por Monte Carlo
  const xLo = Math.min(...xs), xHi = Math.max(...xs);
  const desloca = (coefs, yv) => {
    const q = Array.from(coefs);
    q[q.length - 1] -= yv;
    return q;
  };
  const dentro = (coefs, yv) => raizesReais(desloca(coefs, yv))
    .filter((r) => r >= xLo && r <= xHi);
  const boas = dentro(c, yMedido);
  if (!boas.length) return { erro: "nenhuma solução dentro da faixa calibrada" };
  if (boas.length > 1) {
    return { erro: "a curva não é monótona aqui: " + boas.length + " soluções ("
      + boas.map((b) => _g(b)).join(", ") + ")" };
  }
  const xEst = boas[0];

  const L = cholesky(ajuste.cov);
  const amostras = [];
  if (L) {
    const rng = geradorComSemente(12345);
    const p = c.length;
    for (let k = 0; k < 2000; k++) {
      const z = Array.from({ length: p }, () => normal(rng));
      const cs = c.map((v, i) => {
        let s = v;
        for (let j = 0; j <= i; j++) s += L[i][j] * z[j];
        return s;
      });
      const ruido = normal(rng) * ajuste.s_yx / Math.sqrt(Math.max(1, m));
      const b = dentro(cs, yMedido + ruido);
      if (b.length === 1) amostras.push(b[0]);
    }
  }
  if (amostras.length > 100) {
    const v = Float64Array.from(amostras);
    const lo = percentil(v, 2.5), hi = percentil(v, 97.5);
    return { x: xEst, u: (hi - lo) / 3.92, meia_largura: (hi - lo) / 2,
             confianca: 0.95, metodo: "Monte Carlo sobre a covariância" };
  }
  return { x: xEst, u: NaN, meia_largura: NaN, confianca: 0.95,
           metodo: "raiz sem incerteza" };
}

// ------------------------------------------------------- varredura de R²
/**
 * R² da regressão de Y contra X, frequência a frequência.
 *
 * `matrizY` tem uma linha por ponto de calibração e uma coluna por frequência.
 * É o modo de descobrir ONDE o sensor responde, em vez de adivinhar.
 */
export function varreduraR2(freqs, matrizY, x) {
  if (!matrizY.length || matrizY.length !== x.length) {
    return { erro: "a matriz precisa de uma linha por ponto de calibração" };
  }
  const nF = matrizY[0].length;
  const r2 = new Array(nF).fill(null);
  const incl = new Array(nF).fill(null);
  let melhor = -1, jMelhor = -1;
  for (let j = 0; j < nF; j++) {
    const xs = [], ys = [];
    for (let i = 0; i < matrizY.length; i++) {
      const v = matrizY[i][j];
      if (Number.isFinite(v)) { xs.push(x[i]); ys.push(v); }
    }
    if (xs.length < 3) continue;
    const r = regressaoLinear(Float64Array.from(xs), Float64Array.from(ys));
    if (!r) continue;
    r2[j] = r.r2; incl[j] = r.inclinacao;
    if (Number.isFinite(r.r2) && r.r2 > melhor) { melhor = r.r2; jMelhor = j; }
  }
  if (jMelhor < 0) return { erro: "não houve nenhuma frequência ajustável" };
  return { freqs: Array.from(freqs), r2: r2, inclinacao: incl,
           melhor_hz: freqs[jMelhor], melhor_r2: r2[jMelhor],
           melhor_inclinacao: incl[jMelhor] };
}

// ---------------------------------------------------------- planejamento
/**
 * Lista de trabalho em ordem aleatória, com retornos intercalados.
 *
 * A ordem aleatória é o que permite separar a resposta ao X da deriva no
 * tempo; os retornos ao ponto de referência são o que torna a deriva visível.
 * A semente fica guardada, senão a série não é reproduzível.
 *
 * AVISO: o gerador daqui não é o do numpy. A MESMA semente dá uma ordem
 * diferente da que o MWFlow em Python daria. Dentro de uma implementação a
 * semente reproduz a série; entre as duas, não.
 */
export function planejaSerie(xMin, xMax, passo, opcoes = {}) {
  const replicas = opcoes.replicas || 1;
  const referencia = opcoes.referencia;
  const intercalar = opcoes.intercalar_a_cada || 3;
  const semente = opcoes.semente || (Math.floor(Date.now() / 1000) % 100000);
  const rng = geradorComSemente(semente);
  const niveis = [];
  for (let v = xMin; v <= xMax + passo / 2; v += passo) {
    niveis.push(Math.round(v * 1e6) / 1e6);
  }
  const lista = [];
  for (let r = 0; r < replicas; r++) {
    const rep = String.fromCharCode(65 + r);
    const ordem = embaralha(niveis, rng);
    ordem.forEach((v, k) => {
      lista.push({ x: v, replica: rep });
      if (referencia !== null && referencia !== undefined
          && (k + 1) % intercalar === 0) {
        lista.push({ x: Number(referencia), replica: rep + "-ref" });
      }
    });
  }
  lista.forEach((item, i) => { item.ordem_sorteada = i + 1; });
  return { semente: semente, n: lista.length, itens: lista };
}

// ---------------------------------------------------------------- resumo
/** A frase que a tela mostra. A faixa nunca sai do lado da sensibilidade. */
export function textoResumo(a, unidadeX = "", unidadeY = "") {
  if (a.erro) return a.erro;
  const fx = a.faixa || [null, null];
  const faixa = (fx[0] !== null || fx[1] !== null)
    ? "faixa " + _g(fx[0]) + " a " + _g(fx[1]) + " " + unidadeX
    : "faixa completa";
  const l1 = "S = " + _g(a.sensibilidade) + " " + (unidadeY || "y") + "/"
    + (unidadeX || "x") + "  (" + faixa + ", n = " + a.n + ", R² = "
    + _g(a.r2, 4) + ")";
  const origem = { medida: "medido", assumida: "suposto",
                   residuo: "do resíduo do ajuste" }[a.sigma_origem]
                 || a.sigma_origem;
  const l2 = "LOD = " + _g(a.lod) + " " + unidadeX + "  (3σ, σ = "
    + _g(a.sigma_y) + " " + unidadeY + " " + origem + ")";
  return l1 + "\n" + l2;
}

/** Equivalente do `%.4g` do Python, para o texto bater com o do servidor. */
export function _g(v, casas = 4) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
  v = Number(v);
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  let s;
  if (e < -4 || e >= casas) {
    s = v.toExponential(casas - 1).replace(/\.?0+e/, "e");
    s = s.replace(/e([+-])(\d)$/, "e$10$2");
  } else {
    s = v.toFixed(Math.max(0, casas - 1 - e));
    if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
  }
  return s;
}
