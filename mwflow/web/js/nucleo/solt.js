/* Calibração SOLT — gêmeo de `mwflow/solt.py`.
 *
 * MODELO DE UMA PORTA. O refletido medido se liga ao real por
 *
 *     Gm = e00 + (e10e01 · Ga) / (1 − e11 · Ga)
 *
 * Para resolver, use a forma bilinear equivalente, com de = e00·e11 − e10e01:
 *
 *     Gm = (e00 − de·Ga) / (1 − e11·Ga)
 *     =>  e00·1 + e11·(Ga·Gm) + de·(−Ga) = Gm
 *
 * Três padrões dão, EM CADA FREQUÊNCIA, um sistema linear complexo 3x3.
 *
 * CORREÇÃO:
 *
 *     Ga = (Gm − e00) / (e11·(Gm − e00) + e10e01)
 *
 * CONDICIONAMENTO. Se os três padrões caírem perto uns dos outros na carta de
 * Smith, o sistema fica malcondicionado e os termos de erro saem lixo — sem
 * nenhum aviso. Por isso o número de condição é calculado em cada frequência e
 * denunciado. É assim que um padrão mal conectado ou danificado aparece.
 *
 * TRANSMISSÃO. Com isolamento `e30` e rastreio `e10e32`:
 *
 *     S21a = ((S21m − e30) / e10e32) · (1 − e11 · S11a)
 *
 * O último fator é a parte "melhorada": ele tira a rereflexão do descasamento
 * da fonte na entrada do dispositivo. Num ressoador, onde |S11| vai de quase 1
 * fora da ressonância a 0,3 no pico, essa correção não é pequena.
 *
 * O QUE ESTA CALIBRAÇÃO NÃO CORRIGE — e a interface tem de dizer:
 *
 * - O casamento da porta 2 (`e22`) é INOBSERVÁVEL sem chave de reversão. O
 *   erro residual do S21 vale aproximadamente |e22·S22|. Num ressoador de
 *   transmissão com acoplamento fraco, |S22| é grande fora da ressonância e
 *   varia rápido através dela, então esse termo **enviesa o Q**, e não apenas
 *   a amplitude. A correção é física e barata: um atenuador de 6 a 10 dB fixo
 *   na porta 2 melhora |e22| pelo dobro do valor em dB.
 * - S12 e S22 não são medidos. Nunca.
 * - Não existe correção de 12 termos aqui.
 */

"use strict";

import * as kitCal from "./kit_cal.js";
import { ajustaPolinomio, anguloC, absC, complexo, condicao3C, desdobra,
         interpola as interpolaLinear, maximo, mediana, minimo,
         resolve3C } from "./num.js";

export const COND_LIMITE = 1e6;

// --------------------------------------------------------------- resolução
/**
 * Termos de erro de uma porta.
 *
 * `medidos` traz os vetores complexos medidos de aberto, curto e carga.
 * Devolve `{f, e00, e11, e10e01, cond}`.
 */
export function resolveUmaPorta(f, medidos, kit) {
  const ideais = kitCal.padroes(f, kit);
  const nomes = ["aberto", "curto", "carga"];
  const nf = f.length;
  const e00 = complexo(nf), e11 = complexo(nf), e10e01 = complexo(nf);
  const cond = new Float64Array(nf);

  for (let k = 0; k < nf; k++) {
    const A = [], b = [];
    for (const nome of nomes) {
      const gar = ideais[nome].re[k], gai = ideais[nome].im[k];
      const gmr = medidos[nome].re[k], gmi = medidos[nome].im[k];
      A.push([[1, 0],
              [gar * gmr - gai * gmi, gar * gmi + gai * gmr],   // Ga·Gm
              [-gar, -gai]]);                                    // −Ga
      b.push([gmr, gmi]);
    }
    cond[k] = condicao3C(A);
    const x = resolve3C(A, b);
    if (!x) {
      e00.re[k] = NaN; e00.im[k] = NaN;
      e11.re[k] = NaN; e11.im[k] = NaN;
      e10e01.re[k] = NaN; e10e01.im[k] = NaN;
      continue;
    }
    e00.re[k] = x[0][0]; e00.im[k] = x[0][1];
    e11.re[k] = x[1][0]; e11.im[k] = x[1][1];
    // e10e01 = e00·e11 − de
    e10e01.re[k] = x[0][0] * x[1][0] - x[0][1] * x[1][1] - x[2][0];
    e10e01.im[k] = x[0][0] * x[1][1] + x[0][1] * x[1][0] - x[2][1];
  }
  return { f: Float64Array.from(f), e00: e00, e11: e11, e10e01: e10e01,
           cond: cond };
}

/**
 * Termos de transmissão: isolamento e rastreio.
 *
 * O isolamento é medido no piso de ruído. Se ele não for muito promediado, ele
 * INJETA ruído em vez de tirar diafonia — por isso é opcional e vem desligado
 * por padrão.
 */
export function resolveTransmissao(f, thru, isolamento = null, kit = null) {
  const n = f.length;
  const e30 = complexo(n);
  if (isolamento) { e30.re.set(isolamento.re); e30.im.set(isolamento.im); }
  const definido = kit ? kitCal.s21Thru(f, kit.thru || { tau: 0 })
                       : { re: new Float64Array(n).fill(1),
                           im: new Float64Array(n) };
  const e10e32 = complexo(n);
  for (let i = 0; i < n; i++) {
    const nr = thru.re[i] - e30.re[i], ni = thru.im[i] - e30.im[i];
    const dr = definido.re[i], di = definido.im[i];
    const d = dr * dr + di * di;
    e10e32.re[i] = (nr * dr + ni * di) / d;
    e10e32.im[i] = (ni * dr - nr * di) / d;
  }
  return { e30: e30, e10e32: e10e32 };
}

// --------------------------------------------------------------- aplicação
/** Aplica a correção. Devolve `{s11, s21}`. */
export function corrige(termos, s11m, s21m = null) {
  const n = s11m.re.length;
  const s11 = complexo(n);
  for (let i = 0; i < n; i++) {
    const dr = s11m.re[i] - termos.e00.re[i];
    const di = s11m.im[i] - termos.e00.im[i];
    // den = e11·d + e10e01
    const br = termos.e11.re[i] * dr - termos.e11.im[i] * di + termos.e10e01.re[i];
    const bi = termos.e11.re[i] * di + termos.e11.im[i] * dr + termos.e10e01.im[i];
    const m = br * br + bi * bi;
    s11.re[i] = (dr * br + di * bi) / m;
    s11.im[i] = (di * br - dr * bi) / m;
  }
  if (!s21m || !termos.e10e32) return { s11: s11, s21: s21m };
  const s21 = complexo(n);
  for (let i = 0; i < n; i++) {
    const e30r = termos.e30 ? termos.e30.re[i] : 0;
    const e30i = termos.e30 ? termos.e30.im[i] : 0;
    const nr = s21m.re[i] - e30r, ni = s21m.im[i] - e30i;
    const dr = termos.e10e32.re[i], di = termos.e10e32.im[i];
    const m = dr * dr + di * di;
    const qr = (nr * dr + ni * di) / m, qi = (ni * dr - nr * di) / m;
    // fator (1 − e11·s11)
    const fr = 1 - (termos.e11.re[i] * s11.re[i] - termos.e11.im[i] * s11.im[i]);
    const fi = -(termos.e11.re[i] * s11.im[i] + termos.e11.im[i] * s11.re[i]);
    s21.re[i] = qr * fr - qi * fi;
    s21.im[i] = qr * fi + qi * fr;
  }
  return { s11: s11, s21: s21 };
}

// ------------------------------------------------------------ interpolação
/**
 * Interpola em módulo e fase desdobrada, nunca em parte real e imaginária.
 *
 * Com 1 ns de cabo, `e10e01` dá uma volta inteira a cada 500 MHz. Interpolar a
 * parte real numa grade grossa produziria ondulação de amplitude que não
 * existe. Tirar a fase linear antes resolve isso.
 */
function interpolaComplexo(fOrig, v, fNovo) {
  const fase = desdobra(anguloC(v));
  const p = ajustaPolinomio(fOrig, fase, 1);
  const resto = new Float64Array(fase.length);
  for (let i = 0; i < fase.length; i++) {
    resto[i] = fase[i] - (p.coefs[0] * fOrig[i] + p.coefs[1]);
  }
  const mag = interpolaLinear(fNovo, fOrig, absC(v));
  const res = interpolaLinear(fNovo, fOrig, resto);
  const saida = complexo(fNovo.length);
  for (let i = 0; i < fNovo.length; i++) {
    const ang = p.coefs[0] * fNovo[i] + p.coefs[1] + res[i];
    saida.re[i] = mag[i] * Math.cos(ang);
    saida.im[i] = mag[i] * Math.sin(ang);
  }
  return saida;
}

/** Leva os termos de erro para outra grade. Extrapolar é proibido. */
export function interpola(termos, fNovo) {
  const f = termos.f;
  if (minimo(fNovo) < minimo(f) - 1 || maximo(fNovo) > maximo(f) + 1) {
    throw new RangeError(
      "a banda pedida (" + (minimo(fNovo) / 1e6).toFixed(3) + " a "
      + (maximo(fNovo) / 1e6).toFixed(3) + " MHz) sai da banda calibrada ("
      + (minimo(f) / 1e6).toFixed(3) + " a " + (maximo(f) / 1e6).toFixed(3)
      + " MHz). Extrapolar calibração é pior do que não calibrar: o resultado "
      + "parece plausível e está errado.");
  }
  const novo = { f: Float64Array.from(fNovo),
                 cond: interpolaLinear(fNovo, f,
                                       termos.cond || new Float64Array(f.length).fill(1)) };
  for (const k of ["e00", "e11", "e10e01", "e30", "e10e32"]) {
    if (termos[k]) novo[k] = interpolaComplexo(f, termos[k], fNovo);
  }
  novo.aviso = null;
  if (fNovo.length > 4 * f.length) {
    novo.aviso = "a grade nova é " + (fNovo.length / f.length).toFixed(1)
      + " vezes mais densa que a da calibração; a interpolação não inventa a "
      + "resolução que a calibração não tem";
  }
  return novo;
}

/**
 * Interpola dois conjuntos de termos no tempo. `peso` vai de 0 a 1.
 *
 * HIPÓTESE, que a tela precisa declarar: a deriva é lenta e monótona. Se
 * alguém mexeu num cabo ou trocou um conector no meio da sessão, isto é
 * inválido — e é por isso que a diferença entre os dois conjuntos é medida e
 * denunciada quando passa do limite.
 */
export function misturaNoTempo(ini, fim, peso) {
  peso = Math.min(1, Math.max(0, peso));
  const saida = { f: ini.f, cond: ini.cond };
  for (const k of ["e00", "e11", "e10e01", "e30", "e10e32"]) {
    if (ini[k] && fim[k]) {
      const ma = absC(ini[k]), mb = absC(fim[k]);
      const pa = desdobra(anguloC(ini[k])), pb = desdobra(anguloC(fim[k]));
      const z = complexo(ma.length);
      for (let i = 0; i < ma.length; i++) {
        const m = (1 - peso) * ma[i] + peso * mb[i];
        const a = (1 - peso) * pa[i] + peso * pb[i];
        z.re[i] = m * Math.cos(a);
        z.im[i] = m * Math.sin(a);
      }
      saida[k] = z;
    } else if (ini[k]) {
      saida[k] = ini[k];
    }
  }
  return saida;
}

/** Quanto os dois conjuntos diferem, em dB. Serve de portão do colchete. */
export function distancia(a, b) {
  const saida = {};
  for (const k of ["e00", "e11", "e10e01", "e10e32"]) {
    if (!a[k] || !b[k]) continue;
    let pior = 0;
    for (let i = 0; i < a[k].re.length; i++) {
      const d = Math.hypot(a[k].re[i] - b[k].re[i], a[k].im[i] - b[k].im[i]);
      const ref = Math.max(Math.hypot(a[k].re[i], a[k].im[i]), 1e-12);
      pior = Math.max(pior, d / ref);
    }
    saida[k] = 20 * Math.log10(pior + 1e-30);
  }
  return saida;
}

// ------------------------------------------------------------ reverificação
/**
 * Mede o desvio dos padrões contra o ideal, com a calibração VIGENTE.
 *
 * Isto não recalcula nada e não muda dado nenhum: é um número de qualidade.
 * Portão: uma carga acima de −30 dB reprova a sessão.
 */
export function reverifica(f, termos, medidos, kit) {
  const ideais = kitCal.padroes(f, kit);
  const r = {};
  for (const nome of ["aberto", "curto", "carga"]) {
    if (!medidos[nome]) continue;
    const corr = corrige(termos, medidos[nome]).s11;
    if (nome === "carga") {
      const db = new Float64Array(corr.re.length);
      for (let i = 0; i < db.length; i++) {
        db[i] = 20 * Math.log10(Math.hypot(corr.re[i], corr.im[i]) + 1e-30);
      }
      r[nome] = { pior_db: maximo(db), mediana_db: mediana(db) };
    } else {
      let piorFase = 0, piorMag = 0;
      for (let i = 0; i < corr.re.length; i++) {
        const ir = ideais[nome].re[i], ii = ideais[nome].im[i];
        const d = ir * ir + ii * ii;
        const qr = (corr.re[i] * ir + corr.im[i] * ii) / d;
        const qi = (corr.im[i] * ir - corr.re[i] * ii) / d;
        piorFase = Math.max(piorFase, Math.abs(Math.atan2(qi, qr) * 180 / Math.PI));
        const mag = 20 * Math.log10(
          Math.hypot(corr.re[i], corr.im[i]) / Math.hypot(ir, ii) + 1e-30);
        piorMag = Math.max(piorMag, Math.abs(mag));
      }
      r[nome] = { pior_fase_graus: piorFase, pior_mag_db: piorMag };
    }
  }
  r.veredito = ((r.carga && r.carga.pior_db) || -99) > -30 ? "reprovado"
                                                          : "aprovado";
  return r;
}
