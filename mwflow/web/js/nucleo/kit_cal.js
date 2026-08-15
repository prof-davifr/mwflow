/* Modelos dos padrões de calibração — gêmeo de `mwflow/kit_cal.py`.
 *
 * Um padrão real não é um aberto ideal. Ele é uma linha de transmissão curta e
 * com perda, terminada em algo quase ideal. Ignorar isso é o erro mais comum
 * de uma calibração caseira: um aberto SMA típico tem 50 fF de capacitância de
 * franja, o que já dá **−5,4° de fase em 3 GHz** e −10,8° em 6 GHz. Para medir
 * o Q de um ressoador isso não é detalhe.
 *
 * O modelo aqui é o definicional da Keysight/HP, para qualquer definição de
 * kit publicada poder ser digitada direto.
 *
 * LINHA DE OFFSET, com atraso `tau` (s, de ida), impedância `z_off` e perda
 * `perda` (ohm/s, especificada em 1 GHz):
 *
 *     alfa_l = perda · tau / (2·z_off) · sqrt(f / 1e9)
 *     beta_l = 2π·f·tau + alfa_l
 *     gama_l = alfa_l + j·beta_l
 *
 * O termo de fase igual a `alfa_l` faz parte do modelo — ele é o efeito
 * pelicular, e omiti-lo é um defeito clássico.
 *
 * AVISO. Os valores de `sma_generico` são um CHUTE razoável, não uma
 * caracterização. Um kit de verdade traz os coeficientes dele; use-os. O
 * MWFlow guarda o kit POR VALOR dentro de cada conjunto de calibração, para
 * uma calibração antiga continuar interpretável mesmo que o arquivo do kit
 * mude.
 */

"use strict";

import { complexo } from "./num.js";

export const Z0 = 50.0;

export const KITS_EMBUTIDOS = {
  ideal: {
    nome: "ideal",
    descricao: "padrões perfeitos. Serve para teste sintético, não para bancada.",
    aberto: { tau: 0.0, perda: 0.0, z_off: 50.0, c: [0, 0, 0, 0] },
    curto: { tau: 0.0, perda: 0.0, z_off: 50.0, l: [0, 0, 0, 0] },
    carga: { tau: 0.0, perda: 0.0, z_off: 50.0, gama: 0.0 },
    thru: { tau: 0.0, perda_db: 0.0 },
  },
  sma_generico: {
    nome: "sma_generico",
    descricao: "valores plausíveis de um kit SMA comum. SUBSTITUA pelos "
      + "coeficientes do seu kit assim que os tiver.",
    // C em 1e-15, 1e-27, 1e-36, 1e-45 F; L em 1e-12, 1e-24, 1e-33, 1e-42 H
    aberto: { tau: 29.24e-12, perda: 2.2e9, z_off: 50.0,
              c: [50.0, -310.0, 23.2, -0.16] },
    curto: { tau: 31.79e-12, perda: 2.36e9, z_off: 50.0,
             l: [2.077, -108.5, 2.171, -0.01] },
    carga: { tau: 0.0, perda: 0.0, z_off: 50.0, gama: 0.0 },
    thru: { tau: 0.0, perda_db: 0.0 },
  },
};

export const ESCALA_C = [1e-15, 1e-27, 1e-36, 1e-45];
export const ESCALA_L = [1e-12, 1e-24, 1e-33, 1e-42];

/** gama_l num ponto. Devolve [alfa, beta]. */
function gamaL(f, tau, perda, zOff) {
  if (tau === 0 && perda === 0) return [0, 0];
  const alfa = (perda * tau / (2 * zOff)) * Math.sqrt(Math.max(f, 0) / 1e9);
  return [alfa, 2 * Math.PI * f * tau + alfa];
}

/** Aplica a linha de offset a uma terminação, num ponto. */
function comOffset(f, gtr, gti, tau, perda, zOff) {
  const [alfa, beta] = gamaL(f, tau, perda, zOff);
  // e^{-2γl}
  const m2 = Math.exp(-2 * alfa);
  const e2r = m2 * Math.cos(-2 * beta), e2i = m2 * Math.sin(-2 * beta);
  if (Math.abs(zOff - Z0) < 1e-12) {
    return [gtr * e2r - gti * e2i, gtr * e2i + gti * e2r];
  }
  const g1 = (zOff - Z0) / (zOff + Z0);
  const denr = 1 - g1 * g1 * e2r, deni = -g1 * g1 * e2i;
  const dd = denr * denr + deni * deni;
  // s11 = g1·(1 − e2)/den
  const n1r = g1 * (1 - e2r), n1i = -g1 * e2i;
  const s11r = (n1r * denr + n1i * deni) / dd;
  const s11i = (n1i * denr - n1r * deni) / dd;
  // s21² = ((1 − g1²)·e^{-γl}/den)²
  const m1 = Math.exp(-alfa);
  const e1r = m1 * Math.cos(-beta), e1i = m1 * Math.sin(-beta);
  const k = 1 - g1 * g1;
  const tr = (k * e1r * denr + k * e1i * deni) / dd;
  const ti = (k * e1i * denr - k * e1r * deni) / dd;
  const t2r = tr * tr - ti * ti, t2i = 2 * tr * ti;
  // s11 + s21²·gt/(1 − s11·gt)
  const ur = 1 - (s11r * gtr - s11i * gti), ui = -(s11r * gti + s11i * gtr);
  const uu = ur * ur + ui * ui;
  const vr = t2r * gtr - t2i * gti, vi = t2r * gti + t2i * gtr;
  return [s11r + (vr * ur + vi * ui) / uu, s11i + (vi * ur - vr * ui) / uu];
}

export function gamaAberto(f, d) {
  const n = f.length, z = complexo(n);
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let k = 0; k < 4; k++) c += d.c[k] * ESCALA_C[k] * Math.pow(f[i], k);
    const w = 2 * Math.PI * f[i];
    // (1 − jwCZ0)/(1 + jwCZ0)
    const x = w * c * Z0;
    const den = 1 + x * x;
    const [gr, gi] = [(1 - x * x) / den, -2 * x / den];
    const r = comOffset(f[i], gr, gi, d.tau, d.perda, d.z_off);
    z.re[i] = r[0]; z.im[i] = r[1];
  }
  return z;
}

export function gamaCurto(f, d) {
  const n = f.length, z = complexo(n);
  for (let i = 0; i < n; i++) {
    let l = 0;
    for (let k = 0; k < 4; k++) l += d.l[k] * ESCALA_L[k] * Math.pow(f[i], k);
    const w = 2 * Math.PI * f[i];
    // (jwL − Z0)/(jwL + Z0)
    const x = w * l;
    const den = x * x + Z0 * Z0;
    const [gr, gi] = [(x * x - Z0 * Z0) / den, 2 * x * Z0 / den];
    const r = comOffset(f[i], gr, gi, d.tau, d.perda, d.z_off);
    z.re[i] = r[0]; z.im[i] = r[1];
  }
  return z;
}

export function gamaCarga(f, d) {
  const n = f.length, z = complexo(n);
  const g = Number(d.gama || 0);
  for (let i = 0; i < n; i++) {
    const r = comOffset(f[i], g, 0, d.tau || 0, d.perda || 0, d.z_off || Z0);
    z.re[i] = r[0]; z.im[i] = r[1];
  }
  return z;
}

export function s21Thru(f, d) {
  const n = f.length, z = complexo(n);
  const a = Math.pow(10, -Math.abs(d.perda_db || 0) / 20);
  const tau = d.tau || 0;
  for (let i = 0; i < n; i++) {
    const fi = -2 * Math.PI * f[i] * tau;
    z.re[i] = a * Math.cos(fi);
    z.im[i] = a * Math.sin(fi);
  }
  return z;
}

/** Reflexão verdadeira de cada padrão, na grade `f`. */
export function padroes(f, kit) {
  return {
    aberto: gamaAberto(f, kit.aberto),
    curto: gamaCurto(f, kit.curto),
    carga: gamaCarga(f, kit.carga),
  };
}

// ------------------------------------------------------------------ disco
/* Os kits do usuário moram no `localStorage`: são poucos e minúsculos, e
   assim sobrevivem ao recarregamento da página sem pedir permissão nenhuma. */
const CHAVE = "mwflow.kits";

function lidos() {
  try {
    return JSON.parse(localStorage.getItem(CHAVE) || "{}");
  } catch (e) {
    return {};
  }
}

export function salvaKit(kit) {
  const d = lidos();
  d[kit.nome] = kit;
  localStorage.setItem(CHAVE, JSON.stringify(d));
}

export function carregaKit(nome) {
  const d = lidos();
  if (d[nome]) return JSON.parse(JSON.stringify(d[nome]));
  if (KITS_EMBUTIDOS[nome]) return JSON.parse(JSON.stringify(KITS_EMBUTIDOS[nome]));
  throw new Error("kit desconhecido: " + nome);
}

export function listaKits() {
  const nomes = new Set(Object.keys(KITS_EMBUTIDOS));
  for (const k of Object.keys(lidos())) nomes.add(k);
  return Array.from(nomes).sort();
}
