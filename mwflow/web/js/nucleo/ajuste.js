/* Extração de f_res por AJUSTE, não por argmax.
 *
 * Gêmeo de `mwflow/ajuste.py`, que por sua vez é cópia atribuída de
 * `sensor-etanol/src/sensor_etanol/ajuste.py` (commit cac3b63, 2026-07-28).
 * Se o estimador precisar mudar, mude lá e recopie nos dois — não divirja em
 * silêncio.
 *
 * POR QUE NÃO ARGMAX. Um ressoador com Q ≈ 9 tem FWHM ≈ 175 MHz, e o topo do
 * pico é quase plano: 0,5 MHz fora do ápice o |S21| cai 13 ppm. O `argmax`
 * sobre a grade fica então dominado por ruído numérico — duas corridas da
 * MESMA configuração dão f_res com 0,3 a 0,4 MHz de diferença. Os
 * deslocamentos que o sensor precisa medir são de 2,7 a 12 MHz, ou seja, o
 * ruído do estimador chegava a 15 % do sinal.
 *
 * O ajuste usa a curva INTEIRA em vez do ponto mais alto, e o S21 COMPLEXO em
 * vez do módulo — a fase varia rápido na ressonância mesmo quando o módulo é
 * chato, e é ela que fixa f_res com precisão.
 *
 * Modelo de um polo com fundo (acoplamento por gaps série):
 *
 *     S21(f) = C + A / (1 + 2j Q (f − f0) / f0)
 *
 * com C e A complexos. Devolve f0, Q e o resíduo rms.
 *
 * Viés de estimador: Petersan & Anlage, J. Appl. Phys. 84, 3392 (1998).
 *
 * O OTIMIZADOR. O Python usa `scipy.optimize.least_squares(method="lm")`, que
 * é o lmdif do MINPACK. Aqui vai um Levenberg-Marquardt com escalonamento de
 * Marquardt — o termo de amortecimento multiplica a diagonal de JᵀJ, e não a
 * identidade. Sem isso o ajuste não anda: f0 vale 1,5e9 e as outras incógnitas
 * valem cerca de 1, e um passo isotrópico seria absurdo em uma das direções.
 */

"use strict";

import { inverte } from "./num.js";

export const BANDA_PADRAO = [1.30e9, 2.00e9];

/** S21 do modelo, ponto a ponto. `p` = [cr, ci, ar, ai, Q, f0]. */
export function modelo(p, f) {
  const n = f.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  const [cr, ci, ar, ai, Q, f0] = p;
  for (let i = 0; i < n; i++) {
    const x = 2 * Q * (f[i] - f0) / f0;
    const d = 1 + x * x;
    const lr = 1 / d, li = -x / d;
    re[i] = cr + ar * lr - ai * li;
    im[i] = ci + ar * li + ai * lr;
  }
  return { re: re, im: im };
}

/** Resíduo empilhado: primeiro as partes reais, depois as imaginárias. */
function residuo(p, f, sre, sim) {
  const m = modelo(p, f);
  const n = f.length;
  const r = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    r[i] = m.re[i] - sre[i];
    r[n + i] = m.im[i] - sim[i];
  }
  return r;
}

function normaQuadrada(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return s;
}

/**
 * Levenberg-Marquardt com Jacobiana numérica por diferença adiantada.
 *
 * O passo da diferença é `sqrt(eps)·max(|p|, 1)`, o mesmo critério do MINPACK.
 * O laço para quando a redução relativa do custo e o passo relativo ficam
 * abaixo de 1e-14 — bem mais apertado do que o padrão do scipy, de propósito:
 * as duas implementações têm de cair no mesmo mínimo até onde o problema
 * permite, senão a paridade com o Python vira uma discussão sobre o critério
 * de parada.
 */
export function levenbergMarquardt(fun, p0, maxIter = 200) {
  const n = p0.length;
  let p = Array.from(p0);
  let r = fun(p);
  let custo = normaQuadrada(r);
  let lambda = 1e-3;
  const raizEps = Math.sqrt(Number.EPSILON);

  for (let iter = 0; iter < maxIter; iter++) {
    const m = r.length;
    // Jacobiana por coluna
    const J = [];
    for (let j = 0; j < n; j++) {
      const h = raizEps * Math.max(Math.abs(p[j]), 1);
      const q = Array.from(p);
      q[j] += h;
      const rq = fun(q);
      const col = new Float64Array(m);
      for (let i = 0; i < m; i++) col[i] = (rq[i] - r[i]) / h;
      J.push(col);
    }
    // JᵀJ e Jᵀr
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      for (let i = 0; i < m; i++) g[a] += J[a][i] * r[i];
      for (let b = a; b < n; b++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[a][i] * J[b][i];
        A[a][b] = s; A[b][a] = s;
      }
    }
    let melhorou = false;
    for (let tentativa = 0; tentativa < 30; tentativa++) {
      const M = A.map((linha, i) => linha.map((v, j) =>
        (i === j ? v * (1 + lambda) + lambda * 1e-30 : v)));
      const inv = inverte(M);
      if (!inv) { lambda *= 10; continue; }
      const passo = new Array(n).fill(0);
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) passo[a] -= inv[a][b] * g[b];
      }
      const q = p.map((v, i) => v + passo[i]);
      const rq = fun(q);
      const custoQ = normaQuadrada(rq);
      if (Number.isFinite(custoQ) && custoQ < custo) {
        let passoRel = 0;
        for (let i = 0; i < n; i++) {
          passoRel = Math.max(passoRel,
                              Math.abs(passo[i]) / Math.max(Math.abs(p[i]), 1e-30));
        }
        const reducao = (custo - custoQ) / Math.max(custo, 1e-300);
        p = q; r = rq;
        custo = custoQ;
        lambda = Math.max(lambda / 10, 1e-14);
        melhorou = true;
        if (reducao < 1e-14 && passoRel < 1e-14) return { x: p, custo: custo };
        break;
      }
      lambda *= 10;
      if (lambda > 1e14) return { x: p, custo: custo };
    }
    if (!melhorou) return { x: p, custo: custo };
  }
  return { x: p, custo: custo };
}

/**
 * Ajusta o modelo de 1 polo. Devolve `{f0, Q, rms, ilDb}` ou `null`.
 *
 * `banda` restringe a janela; o argmax só entra como CHUTE INICIAL.
 */
export function ajusta(f, s, banda = BANDA_PADRAO) {
  const sel = [];
  for (let i = 0; i < f.length; i++) {
    if (f[i] >= banda[0] && f[i] <= banda[1]) sel.push(i);
  }
  if (sel.length < 20) return null;

  const nf = sel.length;
  const ff = new Float64Array(nf);
  const sre = new Float64Array(nf), sim = new Float64Array(nf);
  const mag = new Float64Array(nf);
  for (let k = 0; k < nf; k++) {
    const i = sel[k];
    ff[k] = f[i]; sre[k] = s.re[i]; sim[k] = s.im[i];
    mag[k] = Math.hypot(s.re[i], s.im[i]);
  }

  let i0 = 0;
  for (let k = 1; k < nf; k++) if (mag[k] > mag[i0]) i0 = k;
  const f00 = ff[i0];

  // Q inicial pela meia-potência (grosseiro, só para semear)
  const meia = mag[i0] / Math.SQRT2;
  let esq = null, dire = null;
  for (let k = i0 - 1; k >= 0; k--) if (mag[k] < meia) { esq = ff[k]; break; }
  for (let k = i0; k < nf; k++) if (mag[k] < meia) { dire = ff[k]; break; }
  const fw = (esq !== null && dire !== null) ? (dire - esq) : f00 / 10.0;
  const Q0 = Math.max(f00 / Math.max(fw, 1e6), 2.0);
  const p0 = [0.0, 0.0, sre[i0], sim[i0], Q0, f00];

  const fun = (p) => residuo(p, ff, sre, sim);
  let r;
  try {
    r = levenbergMarquardt(fun, p0);
  } catch (e) {
    return null;
  }
  const [, , , , Q, f0] = r.x;
  if (!(f0 > banda[0] && f0 < banda[1]) || !(Q > 0)) return null;

  const res = fun(r.x);
  const rms = Math.sqrt(normaQuadrada(res) / res.length);
  const noPico = modelo(r.x, Float64Array.from([f0]));
  const ilDb = 20 * Math.log10(Math.hypot(noPico.re[0], noPico.im[0]));
  return { f0: f0, Q: Math.abs(Q), rms: rms, ilDb: ilDb };
}
