/* Registro de grandezas medidas — gêmeo de `mwflow/observaveis.py`.
 *
 * Uma grandeza aqui é uma função pura de uma varredura. Existem dois tipos:
 *
 * - **traço**: vale ponto a ponto na grade de frequências. Alimenta o
 *   espectrograma direto, e vira um escalar quando amostrado numa frequência.
 * - **derivado**: sai de um ajuste sobre uma banda. Não existe numa frequência
 *   só — e a interface usa esse fato para não deixar o operador pedir `f_res`
 *   em modo de frequência fixa.
 *
 * O mesmo registro alimenta o eixo Y do osciloscópio e o eixo Y da curva de
 * calibração. Acrescentar uma grandeza é escrever uma função aqui; a interface
 * monta os menus a partir de `catalogo()` e não precisa de mudança nenhuma.
 */

"use strict";

import { ajusta } from "./ajuste.js";
import { absC, anguloC, desdobra, gradiente, procuraOrdenado } from "./num.js";

export const Z0 = 50.0;

export const REGISTRO = {};

function registra(id, rotulo, unidade, calcula, opcoes = {}) {
  REGISTRO[id] = {
    id: id, rotulo: rotulo, unidade: unidade,
    tipo: opcoes.tipo || "traco",
    escala: opcoes.escala || "linear",
    saidas: opcoes.saidas || [],
    calcula: calcula,
  };
}

/** Lista serializável, para a interface montar os menus. */
export function catalogo() {
  return Object.values(REGISTRO).map((o) => ({
    id: o.id, rotulo: o.rotulo, unidade: o.unidade, tipo: o.tipo,
    escala: o.escala, saidas: o.saidas.slice(),
  }));
}

// ------------------------------------------------------------------- traços
registra("mag_db", "|S| (dB)", "dB", (f, s) => {
  const m = absC(s), v = new Float64Array(m.length);
  for (let i = 0; i < m.length; i++) v[i] = 20 * Math.log10(m[i]);
  return v;
});

registra("mag_lin", "|S|", "", (f, s) => absC(s));

registra("fase_deg", "fase de S", "graus", (f, s) => {
  const a = anguloC(s), v = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) v[i] = a[i] * 180 / Math.PI;
  return v;
});

registra("fase_desdobrada", "fase desdobrada de S", "graus", (f, s) => {
  const a = desdobra(anguloC(s)), v = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) v[i] = a[i] * 180 / Math.PI;
  return v;
});

registra("re", "Re(S)", "", (f, s) => Float64Array.from(s.re));

registra("im", "Im(S)", "", (f, s) => Float64Array.from(s.im));

registra("vswr", "VSWR", "", (f, s) => {
  const m = absC(s), v = new Float64Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const x = Math.min(Math.max(m[i], 0), 0.999999);
    v[i] = (1 + x) / (1 - x);
  }
  return v;
}, { escala: "log" });

registra("z_re", "Re(Z)", "ohm", (f, s) => {
  const n = s.re.length, v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const nr = 1 + s.re[i], ni = s.im[i];
    const dr = 1 - s.re[i], di = -s.im[i];
    const d = dr * dr + di * di;
    v[i] = Z0 * (nr * dr + ni * di) / d;
  }
  return v;
});

registra("z_im", "Im(Z)", "ohm", (f, s) => {
  const n = s.re.length, v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const nr = 1 + s.re[i], ni = s.im[i];
    const dr = 1 - s.re[i], di = -s.im[i];
    const d = dr * dr + di * di;
    v[i] = Z0 * (ni * dr - nr * di) / d;
  }
  return v;
});

/** −dφ/dω por diferença central. As pontas repetem a vizinha. */
registra("atraso_grupo", "atraso de grupo", "s", (f, s) => {
  const d = gradiente(desdobra(anguloC(s)), f);
  const v = new Float64Array(d.length);
  for (let i = 0; i < d.length; i++) v[i] = -d[i] / (2 * Math.PI);
  return v;
});

// ---------------------------------------------------------------- derivados
export const SAIDAS_AJUSTE = ["f_res", "q", "il_db", "rms", "fwhm_mhz",
                              "prominencia_db"];

/**
 * Recupera C e A do modelo, com f0 e Q já fixados pelo ajuste.
 *
 * Com f0 e Q conhecidos o modelo `S21 = C + A·L(f)` é LINEAR em C e A, então
 * isto é um mínimos quadrados exato de duas incógnitas, sem iteração. Serve
 * para desenhar a curva ajustada por cima dos dados: quando o ajuste está
 * ruim, o operador vê na hora, em vez de confiar num número.
 */
export function coeficientes(f, s, f0, q, banda) {
  // Normais complexas de um sistema 2x2: MᴴM · x = MᴴS, com M = [1, L].
  let a11 = 0;                       // ⟨1,1⟩, real
  let a12r = 0, a12i = 0;            // ⟨1,L⟩
  let a22 = 0;                       // ⟨L,L⟩, real
  let b1r = 0, b1i = 0, b2r = 0, b2i = 0;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < banda[0] || f[i] > banda[1]) continue;
    const x = 2 * q * (f[i] - f0) / f0;
    const d = 1 + x * x;
    const lr = 1 / d, li = -x / d;
    const sr = s.re[i], si = s.im[i];
    a11 += 1;
    a12r += lr; a12i += li;          // conj(1)·L
    a22 += lr * lr + li * li;
    b1r += sr; b1i += si;            // conj(1)·S
    b2r += lr * sr + li * si;        // conj(L)·S
    b2i += lr * si - li * sr;
  }
  // Determinante de [[a11, a12],[conj(a12), a22]] — real, porque é hermitiana.
  const det = a11 * a22 - (a12r * a12r + a12i * a12i);
  if (!(Math.abs(det) > 0)) return null;
  // x = inv(A)·b, com inv de uma hermitiana 2x2.
  const cr = (a22 * b1r - (a12r * b2r - a12i * b2i)) / det;
  const ci = (a22 * b1i - (a12r * b2i + a12i * b2r)) / det;
  const ar = (a11 * b2r - (a12r * b1r + a12i * b1i)) / det;
  const ai = (a11 * b2i - (a12r * b1i - a12i * b1r)) / det;
  return { c: [cr, ci], a: [ar, ai] };
}

registra("ajuste_1polo", "ajuste de 1 polo (f_res, Q, IL)", "", (f, s, banda) => {
  const r = ajusta(f, s, banda);
  if (!r) return null;
  const fwhm = r.Q ? r.f0 / r.Q / 1e6 : NaN;
  let prom = NaN, m = null;
  try {
    m = coeficientes(f, s, r.f0, r.Q, banda);
    if (m) {
      const pico = Math.hypot(m.c[0] + m.a[0], m.c[1] + m.a[1]);
      const fundo = Math.hypot(m.c[0], m.c[1]);
      if (pico > 0 && fundo > 0) prom = 20 * Math.log10(pico / fundo);
    }
  } catch (e) {
    m = null;
  }
  const d = { f_res: r.f0, q: r.Q, il_db: r.ilDb, rms: r.rms,
              fwhm_mhz: fwhm, prominencia_db: prom };
  if (m) d._modelo = [m.c[0], m.c[1], m.a[0], m.a[1]];
  return d;
}, { tipo: "derivado", saidas: SAIDAS_AJUSTE });

export const UNIDADE_ESCALAR = { f_res: "Hz", q: "", il_db: "dB", rms: "",
                                 fwhm_mhz: "MHz", prominencia_db: "dB" };
export const ROTULO_ESCALAR = { f_res: "f_res", q: "Q", il_db: "IL",
                                rms: "rms do ajuste",
                                fwhm_mhz: "largura a meia altura",
                                prominencia_db: "proeminência" };

// ---------------------------------------------------------------- amostragem
/**
 * Valor COMPLEXO de `s` em `fAlvo`, por interpolação.
 *
 * A interpolação é feita nas partes real e imaginária, nunca na fase em graus:
 * uma fase interpolada por cima da volta de +180° para −180° dá resultado sem
 * sentido. O valor complexo nunca dá.
 */
export function amostra(f, s, fAlvo) {
  const n = f.length;
  if (fAlvo <= f[0]) return [s.re[0], s.im[0]];
  if (fAlvo >= f[n - 1]) return [s.re[n - 1], s.im[n - 1]];
  const i = procuraOrdenado(f, fAlvo) - 1;
  const t = (fAlvo - f[i]) / (f[i + 1] - f[i]);
  return [s.re[i] * (1 - t) + s.re[i + 1] * t,
          s.im[i] * (1 - t) + s.im[i + 1] * t];
}

/** Escalar de um observável de traço, numa frequência. */
export function escalarEm(obsId, f, s, fAlvo) {
  const o = REGISTRO[obsId];
  if (!o) throw new Error("observável desconhecido: " + obsId);
  if (o.tipo !== "traco") {
    throw new Error(obsId + " é derivado; ele não existe numa frequência só");
  }
  const z = amostra(f, s, fAlvo);
  return o.calcula(Float64Array.from([fAlvo]),
                   { re: Float64Array.from([z[0]]),
                     im: Float64Array.from([z[1]]) })[0];
}

// ------------------------------------------------------------------ portões
/**
 * Guarda-corpo em volta de `ajusta()`.
 *
 * O otimizador não conhece limites. Num laço ao vivo ele ocasionalmente foge.
 * Estes portões devolvem `ok=false` com o motivo, em vez de deixar um ajuste
 * ruim virar ponto de calibração. Um ponto pulado em silêncio é muito pior do
 * que uma recusa visível.
 */
export class Portoes {
  constructor(opcoes = {}) {
    this.rms_max = opcoes.rms_max === undefined ? 0.25 : opcoes.rms_max;
    this.q_min = opcoes.q_min === undefined ? 1.0 : opcoes.q_min;
    this.q_max = opcoes.q_max === undefined ? 1e5 : opcoes.q_max;
    this.salto_max_hz = opcoes.salto_max_hz || null;
    this.banda_adaptativa = opcoes.banda_adaptativa !== false;
    this.k_banda = opcoes.k_banda === undefined ? 3.0 : opcoes.k_banda;
    this.anterior = null;
  }

  /** Chame após qualquer troca de banda ou de configuração. */
  reinicia() {
    this.anterior = null;
  }

  contaNaBanda(f, lo, hi) {
    let n = 0;
    for (let i = 0; i < f.length; i++) if (f[i] >= lo && f[i] <= hi) n++;
    return n;
  }

  /** Estreita a banda em volta do último pico, quando isso é seguro. */
  bandaDe(pedida, f) {
    if (!(this.banda_adaptativa && this.anterior)) return pedida;
    const f0 = this.anterior.f_res;
    const fw = this.anterior.fwhm_mhz * 1e6;
    if (!Number.isFinite(f0) || !Number.isFinite(fw) || fw <= 0) return pedida;
    const lo = Math.max(pedida[0], f0 - this.k_banda * fw);
    const hi = Math.min(pedida[1], f0 + this.k_banda * fw);
    if (this.contaNaBanda(f, lo, hi) < 20) return pedida;
    return [lo, hi];
  }

  /** Devolve `{valores, ok, motivo, banda}`. */
  estima(f, s, banda) {
    let semDado = 0;
    for (let i = 0; i < s.re.length; i++) {
      if (!Number.isFinite(s.re[i]) || !Number.isFinite(s.im[i])) semDado++;
    }
    if (semDado) {
      return { valores: null, ok: false, banda: banda,
               motivo: semDado + " pontos sem dado na varredura" };
    }
    const b = this.bandaDe(banda, f);
    if (this.contaNaBanda(f, b[0], b[1]) < 20) {
      return { valores: null, ok: false, banda: b,
               motivo: "menos de 20 pontos na banda" };
    }
    const v = REGISTRO.ajuste_1polo.calcula(f, s, b);
    if (!v) {
      return { valores: null, ok: false, banda: b,
               motivo: "o ajuste não convergiu" };
    }
    if (!Number.isFinite(v.rms) || v.rms > this.rms_max) {
      return { valores: v, ok: false, banda: b,
               motivo: "resíduo alto (rms " + v.rms.toPrecision(3) + ")" };
    }
    if (!(v.q >= this.q_min && v.q <= this.q_max)) {
      return { valores: v, ok: false, banda: b,
               motivo: "Q fora do plausível (" + v.q.toPrecision(3) + ")" };
    }
    if (this.salto_max_hz && this.anterior
        && Math.abs(v.f_res - this.anterior.f_res) > this.salto_max_hz) {
      const d = (v.f_res - this.anterior.f_res) / 1e6;
      return { valores: v, ok: false, banda: b,
               motivo: "salto de " + (d >= 0 ? "+" : "") + d.toFixed(2)
                 + " MHz desde a última" };
    }
    this.anterior = v;
    return { valores: v, ok: true, motivo: null, banda: b };
  }
}
