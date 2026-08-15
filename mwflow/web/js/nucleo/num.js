/* Núcleo numérico: o que o numpy e o scipy faziam do lado do Python.
 *
 * REGRA DESTE ARQUIVO. Cada função aqui tem uma gêmea em Python e um vetor de
 * referência em `testes/paridade.mjs`. Quando as duas discordarem, a errada é
 * esta — o Python é a verdade, porque foi ele que produziu os números já
 * publicados. Não "conserte" o teste; conserte a função.
 *
 * REPRESENTAÇÃO. Um vetor complexo é `{re: Float64Array, im: Float64Array}`,
 * e não um vetor de objetos. Uma varredura de 1024 pontos passa por aqui 15
 * vezes por segundo; um objeto por ponto criaria 15 mil objetos por segundo
 * para o coletor de lixo recolher, e o traço engasgaria.
 */

"use strict";

// ------------------------------------------------------------------ básicos
export const NAN = Number.NaN;

export function vetor(n, valor = 0) {
  const v = new Float64Array(n);
  if (valor !== 0) v.fill(valor);
  return v;
}

export function complexo(n) {
  return { re: new Float64Array(n), im: new Float64Array(n) };
}

export function deArray(a) {
  return a instanceof Float64Array ? a : Float64Array.from(a);
}

export function arange(n) {
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = i;
  return v;
}

export function grade(inicio, passo, n) {
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = inicio + passo * i;
  return v;
}

export function soma(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return s;
}

export function media(v) {
  return v.length ? soma(v) / v.length : NAN;
}

/** Desvio padrão. `ddof=1` é o da amostra, que é o usado em metrologia. */
export function desvio(v, ddof = 0) {
  const n = v.length;
  if (n - ddof <= 0) return NAN;
  const m = media(v);
  let s = 0;
  for (let i = 0; i < n; i++) s += (v[i] - m) * (v[i] - m);
  return Math.sqrt(s / (n - ddof));
}

export function minimo(v) {
  let m = Infinity;
  for (let i = 0; i < v.length; i++) if (v[i] < m) m = v[i];
  return m;
}

export function maximo(v) {
  let m = -Infinity;
  for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i];
  return m;
}

export function finitos(v) {
  const s = [];
  for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) s.push(v[i]);
  return Float64Array.from(s);
}

export function mediaFinita(v) {
  let s = 0, n = 0;
  for (let i = 0; i < v.length; i++) {
    if (Number.isFinite(v[i])) { s += v[i]; n++; }
  }
  return n ? s / n : NAN;
}

/** Percentil com interpolação linear — a convenção padrão do numpy. */
export function percentil(v, q) {
  const a = Array.from(v).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NAN;
  const p = (q / 100) * (a.length - 1);
  const i = Math.floor(p), t = p - i;
  return i + 1 < a.length ? a[i] * (1 - t) + a[i + 1] * t : a[i];
}

export function mediana(v) {
  return percentil(v, 50);
}

// --------------------------------------------------------------- complexos
export function absC(z) {
  const n = z.re.length, v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.hypot(z.re[i], z.im[i]);
  return v;
}

export function anguloC(z) {
  const n = z.re.length, v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.atan2(z.im[i], z.re[i]);
  return v;
}

export function mulC(a, b) {
  const n = a.re.length, r = complexo(n);
  for (let i = 0; i < n; i++) {
    r.re[i] = a.re[i] * b.re[i] - a.im[i] * b.im[i];
    r.im[i] = a.re[i] * b.im[i] + a.im[i] * b.re[i];
  }
  return r;
}

export function divC(a, b) {
  const n = a.re.length, r = complexo(n);
  for (let i = 0; i < n; i++) {
    const d = b.re[i] * b.re[i] + b.im[i] * b.im[i];
    r.re[i] = (a.re[i] * b.re[i] + a.im[i] * b.im[i]) / d;
    r.im[i] = (a.im[i] * b.re[i] - a.re[i] * b.im[i]) / d;
  }
  return r;
}

export function somaC(a, b) {
  const n = a.re.length, r = complexo(n);
  for (let i = 0; i < n; i++) { r.re[i] = a.re[i] + b.re[i]; r.im[i] = a.im[i] + b.im[i]; }
  return r;
}

export function subC(a, b) {
  const n = a.re.length, r = complexo(n);
  for (let i = 0; i < n; i++) { r.re[i] = a.re[i] - b.re[i]; r.im[i] = a.im[i] - b.im[i]; }
  return r;
}

/** exp(j·x) ponto a ponto, com x real. */
export function expJ(x) {
  const n = x.length, r = complexo(n);
  for (let i = 0; i < n; i++) { r.re[i] = Math.cos(x[i]); r.im[i] = Math.sin(x[i]); }
  return r;
}

export function constanteC(n, re, im) {
  const r = complexo(n);
  r.re.fill(re); r.im.fill(im);
  return r;
}

export function fatiaC(z, ini, fim) {
  return { re: z.re.slice(ini, fim), im: z.im.slice(ini, fim) };
}

export function selecionaC(z, indices) {
  const r = complexo(indices.length);
  for (let k = 0; k < indices.length; k++) {
    r.re[k] = z.re[indices[k]];
    r.im[k] = z.im[indices[k]];
  }
  return r;
}

export function todosFinitosC(z) {
  for (let i = 0; i < z.re.length; i++) {
    if (!Number.isFinite(z.re[i]) || !Number.isFinite(z.im[i])) return false;
  }
  return true;
}

export function contaNaoFinitosC(z) {
  let n = 0;
  for (let i = 0; i < z.re.length; i++) {
    if (!Number.isFinite(z.re[i]) || !Number.isFinite(z.im[i])) n++;
  }
  return n;
}

// ------------------------------------------------------------------ fase
/** `np.unwrap`: tira os saltos de 2π da fase. */
export function desdobra(fase) {
  const n = fase.length, v = new Float64Array(n);
  if (!n) return v;
  v[0] = fase[0];
  let acumulado = 0;
  for (let i = 1; i < n; i++) {
    let d = fase[i] - fase[i - 1];
    if (d > Math.PI) d -= 2 * Math.PI * Math.ceil((d - Math.PI) / (2 * Math.PI));
    else if (d < -Math.PI) d += 2 * Math.PI * Math.ceil((-d - Math.PI) / (2 * Math.PI));
    acumulado += d;
    v[i] = v[0] + acumulado;
  }
  return v;
}

/** `np.gradient` com `edge_order=1`: central por dentro, lateral nas pontas. */
export function gradiente(y, x) {
  const n = y.length, g = new Float64Array(n);
  if (n < 2) return g;
  for (let i = 1; i < n - 1; i++) {
    const hs = x[i] - x[i - 1], hd = x[i + 1] - x[i];
    g[i] = (hs * hs * y[i + 1] + (hd * hd - hs * hs) * y[i] - hd * hd * y[i - 1])
      / (hs * hd * (hs + hd));
  }
  g[0] = (y[1] - y[0]) / (x[1] - x[0]);
  g[n - 1] = (y[n - 1] - y[n - 2]) / (x[n - 1] - x[n - 2]);
  return g;
}

// ------------------------------------------------------------ interpolação
/** `np.searchsorted` com o lado esquerdo. `x` tem de estar em ordem. */
export function procuraOrdenado(x, alvo) {
  let lo = 0, hi = x.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (x[m] < alvo) lo = m + 1; else hi = m;
  }
  return lo;
}

/** `np.interp`: linear, com as pontas presas ao primeiro e ao último valor. */
export function interpola(xNovo, x, y) {
  const r = new Float64Array(xNovo.length);
  for (let k = 0; k < xNovo.length; k++) {
    const a = xNovo[k];
    if (a <= x[0]) { r[k] = y[0]; continue; }
    if (a >= x[x.length - 1]) { r[k] = y[y.length - 1]; continue; }
    const i = procuraOrdenado(x, a) - 1;
    const t = (a - x[i]) / (x[i + 1] - x[i]);
    r[k] = y[i] * (1 - t) + y[i + 1] * t;
  }
  return r;
}

// ------------------------------------------------------------- álgebra real
/** Resolve A·x = b por eliminação com pivô parcial. `A` é vetor de linhas. */
export function resolve(A, b) {
  const n = b.length;
  const M = A.map((linha, i) => Array.from(linha).concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      if (!k) continue;
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  // Depois da eliminação completa a matriz é diagonal.
  return M.map((linha, i) => linha[n] / linha[i]);
}

/** Inversa de uma matriz pequena, por Gauss-Jordan. Devolve `null` se singular. */
export function inverte(A) {
  const n = A.length;
  const M = A.map((linha, i) => Array.from(linha).concat(
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c];
      if (!k) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((linha) => linha.slice(n));
}

/** Mínimos quadrados de `A·x = y` pelas equações normais. `A` é vetor de linhas. */
export function minimosQuadrados(A, y) {
  const n = A.length, p = A[0].length;
  const AtA = Array.from({ length: p }, () => new Array(p).fill(0));
  const Aty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Aty[a] += A[i][a] * y[i];
      for (let b = a; b < p; b++) AtA[a][b] += A[i][a] * A[i][b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) AtA[a][b] = AtA[b][a];
  const inv = inverte(AtA);
  if (!inv) return null;
  const x = new Array(p).fill(0);
  for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) x[a] += inv[a][b] * Aty[b];
  return { x: x, invAtA: inv };
}

/**
 * `np.polyfit(x, y, grau, cov=True)`.
 *
 * Devolve os coeficientes do MAIOR para o MENOR expoente, como o numpy, e a
 * covariância com o mesmo fator `SSR / (n − grau − 1)` que o numpy usa desde a
 * correção do gh-11196. Esse fator entra no teste t da previsão inversa, então
 * copiá-lo errado mudaria uma decisão de aceitar ou recusar uma leitura.
 */
export function ajustaPolinomio(x, y, grau) {
  const n = x.length, p = grau + 1;
  const A = [];
  for (let i = 0; i < n; i++) {
    const linha = new Array(p);
    for (let j = 0; j < p; j++) linha[j] = Math.pow(x[i], grau - j);
    A.push(linha);
  }
  const s = minimosQuadrados(A, y);
  if (!s) return null;
  let ssr = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 0; j < p; j++) v += A[i][j] * s.x[j];
    ssr += (y[i] - v) * (y[i] - v);
  }
  const fac = n > p ? ssr / (n - p) : NAN;
  const cov = s.invAtA.map((linha) => linha.map((v) => v * fac));
  return { coefs: s.x, cov: cov, ssr: ssr };
}

/** `np.polyval`: coeficientes do maior para o menor expoente. */
export function avaliaPolinomio(c, x) {
  let v = 0;
  for (let i = 0; i < c.length; i++) v = v * x + c[i];
  return v;
}

/** `np.polyder`. */
export function derivaPolinomio(c) {
  const g = c.length - 1;
  if (g < 1) return [0];
  const d = [];
  for (let i = 0; i < g; i++) d.push(c[i] * (g - i));
  return d;
}

/**
 * Raízes reais de um polinômio de grau 1, 2 ou 3, em forma fechada.
 *
 * O `np.roots` usa autovalores da matriz companheira. Aqui o grau nunca passa
 * de 3 (a curva de calibração vai até `poli3`), e a forma fechada é exata e
 * não arrasta um autovalorizador para dentro do navegador.
 */
export function raizesReais(c) {
  const a = Array.from(c);
  while (a.length && Math.abs(a[0]) < 1e-300) a.shift();
  const g = a.length - 1;
  if (g === 1) return [-a[1] / a[0]];
  if (g === 2) {
    const [A, B, C] = a;
    const d = B * B - 4 * A * C;
    if (d < 0) return [];
    const r = Math.sqrt(d);
    return [(-B + r) / (2 * A), (-B - r) / (2 * A)];
  }
  if (g === 3) {
    const [A, B, C, D] = a;
    const b = B / A, cc = C / A, d = D / A;
    const p = cc - b * b / 3;
    const q = 2 * b * b * b / 27 - b * cc / 3 + d;
    const disc = q * q / 4 + p * p * p / 27;
    const desloca = -b / 3;
    if (disc > 0) {
      const r = Math.sqrt(disc);
      const u = Math.cbrt(-q / 2 + r), v = Math.cbrt(-q / 2 - r);
      return [u + v + desloca];
    }
    if (Math.abs(disc) < 1e-300) {
      const u = Math.cbrt(-q / 2);
      return [2 * u + desloca, -u + desloca];
    }
    const raio = Math.sqrt(-p * p * p / 27);
    const fi = Math.acos(Math.max(-1, Math.min(1, -q / (2 * raio))));
    const m = 2 * Math.sqrt(-p / 3);
    return [0, 1, 2].map((k) => m * Math.cos((fi + 2 * Math.PI * k) / 3) + desloca);
  }
  return [];
}

// ---------------------------------------------------------- álgebra complexa
/** Determinante de uma matriz complexa 3x3. Cada elemento é `[re, im]`. */
export function detC3(M) {
  const m = (x, y) => [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]];
  const s = (x, y) => [x[0] - y[0], x[1] - y[1]];
  const t1 = m(M[0][0], s(m(M[1][1], M[2][2]), m(M[1][2], M[2][1])));
  const t2 = m(M[0][1], s(m(M[1][0], M[2][2]), m(M[1][2], M[2][0])));
  const t3 = m(M[0][2], s(m(M[1][0], M[2][1]), m(M[1][1], M[2][0])));
  return [t1[0] - t2[0] + t3[0], t1[1] - t2[1] + t3[1]];
}

/** Resolve um sistema complexo 3x3 por Cramer. É o sistema do SOLT. */
export function resolve3C(A, b) {
  const d = detC3(A);
  const md = d[0] * d[0] + d[1] * d[1];
  if (!(md > 0)) return null;
  const saida = [];
  for (let k = 0; k < 3; k++) {
    const M = A.map((linha, i) => linha.map((v, j) => (j === k ? b[i] : v)));
    const dk = detC3(M);
    saida.push([(dk[0] * d[0] + dk[1] * d[1]) / md,
                (dk[1] * d[0] - dk[0] * d[1]) / md]);
  }
  return saida;
}

/**
 * Número de condição na norma 2 de uma matriz complexa 3x3.
 *
 * `np.linalg.cond` faz isso com a decomposição em valores singulares. Aqui os
 * valores singulares saem da raiz dos autovalores de AᴴA, que é hermitiana 3x3
 * e tem forma fechada. O número serve de alarme: três padrões parecidos demais
 * na carta de Smith dão um sistema malcondicionado e termos de erro que são
 * lixo com cara de resultado.
 */
export function condicao3C(A) {
  // M = A^H A, hermitiana. Guarda a parte real e a imaginária.
  const Mr = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Mi = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sr = 0, si = 0;
      for (let k = 0; k < 3; k++) {
        const ar = A[k][i][0], ai = -A[k][i][1];   // conjugado
        const br = A[k][j][0], bi = A[k][j][1];
        sr += ar * br - ai * bi;
        si += ar * bi + ai * br;
      }
      Mr[i][j] = sr; Mi[i][j] = si;
    }
  }
  const q = (Mr[0][0] + Mr[1][1] + Mr[2][2]) / 3;
  const p1 = (Mr[0][1] ** 2 + Mi[0][1] ** 2) + (Mr[0][2] ** 2 + Mi[0][2] ** 2)
    + (Mr[1][2] ** 2 + Mi[1][2] ** 2);
  const p2 = (Mr[0][0] - q) ** 2 + (Mr[1][1] - q) ** 2 + (Mr[2][2] - q) ** 2 + 2 * p1;
  if (!(p2 > 0)) return 1.0;
  const p = Math.sqrt(p2 / 6);
  // B = (M − qI)/p. O determinante sai pela regra geral de uma 3x3 complexa;
  // a parte imaginária é nula porque B é hermitiana, e serve de conferência.
  const B = [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
    [(i === j ? Mr[i][j] - q : Mr[i][j]) / p, Mi[i][j] / p]));
  const det = detC3(B);
  const r = Math.max(-1, Math.min(1, det[0] / 2));
  const fi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(fi);
  const e3 = q + 2 * p * Math.cos(fi + (2 * Math.PI / 3));
  const e2 = 3 * q - e1 - e3;
  const s = [e1, e2, e3].map((v) => Math.sqrt(Math.max(v, 0)));
  const smax = Math.max(...s), smin = Math.min(...s);
  return smin > 0 ? smax / smin : Infinity;
}

// -------------------------------------------------------------- estatística
/** Beta incompleta regularizada, por fração continuada (Lentz). */
function betaIncompleta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const frente = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  if (x < (a + 1) / (a + b + 2)) return frente * fracaoBeta(a, b, x) / a;
  return 1 - frente * fracaoBeta(b, a, 1 - x) / b;
}

function fracaoBeta(a, b, x) {
  const min = 1e-300, eps = 3e-16;
  let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < min) d = min;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let num = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + num * d; if (Math.abs(d) < min) d = min;
    c = 1 + num / c; if (Math.abs(c) < min) c = min;
    d = 1 / d; h *= d * c;
    num = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + num * d; if (Math.abs(d) < min) d = min;
    c = 1 + num / c; if (Math.abs(c) < min) c = min;
    d = 1 / d;
    const passo = d * c;
    h *= passo;
    if (Math.abs(passo - 1) < eps) break;
  }
  return h;
}

/** log Γ(x) pela série de Lanczos. */
export function lgamma(x) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
             -176.61502916214059, 12.507343278686905, -0.13857109526572012,
             9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Acumulada da distribuição t de Student com `nu` graus de liberdade. */
export function tCdf(t, nu) {
  const x = nu / (nu + t * t);
  const meio = 0.5 * betaIncompleta(nu / 2, 0.5, x);
  return t > 0 ? 1 - meio : meio;
}

/**
 * Quantil da t de Student — o `scipy.stats.t.ppf`.
 *
 * Por bissecção sobre a acumulada. São 200 iterações sobre um intervalo de
 * ±1e4, o que fecha em precisão de máquina, e roda em microssegundos. Este
 * número decide se uma inclinação "difere de zero", então ele não pode ser uma
 * aproximação de tabela.
 */
export function tPpf(p, nu) {
  if (!(p > 0 && p < 1) || !(nu > 0)) return NAN;
  let lo = -1e4, hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (tCdf(m, nu) < p) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/** Regressão linear simples. Devolve inclinação, intercepto e r². */
export function regressaoLinear(x, y) {
  const n = x.length;
  if (n < 2) return null;
  const mx = media(x), my = media(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) * (x[i] - mx);
    syy += (y[i] - my) * (y[i] - my);
  }
  if (!(sxx > 0)) return null;
  const inclinacao = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : NAN;
  return { inclinacao: inclinacao, intercepto: my - inclinacao * mx, r2: r2 };
}

// ---------------------------------------------------------------- aleatório
/**
 * Gerador com semente, para o Monte Carlo da previsão inversa.
 *
 * AVISO HONESTO: este não é o PCG64 do numpy. A mesma semente NÃO dá a mesma
 * sequência dos dois lados, então a incerteza do ramo de Monte Carlo difere do
 * Python nos últimos dígitos. O valor de X não muda; só a barra dele, e só na
 * ordem do espalhamento de 2000 amostras. O `metodo` devolvido diz qual ramo
 * produziu o número.
 */
export function geradorComSemente(semente) {
  let a = semente >>> 0;
  return function () {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal padrão por Box-Muller, sobre o gerador dado. */
export function normal(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Cholesky de uma matriz simétrica positiva. Devolve `null` se não for. */
export function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

/** Embaralhamento de Fisher-Yates, para o planejamento da série. */
export function embaralha(v, rng) {
  const a = Array.from(v);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
