/* Protocolo binário do NanoVNA-V2 / LiteVNA — gêmeo de `mwflow/vna/protocolo.py`.
 *
 * O LiteVNA64 NÃO fala o shell de texto do NanoVNA-H. Ele usa o protocolo
 * binário de registradores da família V2. Medido na bancada em 2026-08-14:
 * `info\r` devolve vazio, e o comando INDICATE (0x0d) devolve 0x32 ('2').
 *
 * Formato da FIFO — cada valor ocupa 32 bytes:
 *
 *     <6i H 6x  =  fwd0(re,im), rev0(re,im), rev1(re,im), freqIndex, reserva
 *
 * Daí saem os dois parâmetros que este hardware mede:
 *
 *     S11 = rev0 / fwd0        S21 = rev1 / fwd0
 *
 * Este módulo só monta e desmonta bytes. Quem abre a porta é `litevna.js`.
 */

"use strict";

import { complexo } from "./num.js";

// ---------------------------------------------------------------- comandos
export const NOP = 0x00;
export const INDICATE = 0x0d;
export const LE1 = 0x10;
export const LE2 = 0x11;
export const LE4 = 0x12;
export const LE_FIFO = 0x18;
export const ESCREVE1 = 0x20;
export const ESCREVE2 = 0x21;
export const ESCREVE4 = 0x22;
export const ESCREVE8 = 0x23;
export const ESCREVE_FIFO = 0x28;

// ----------------------------------------------------------- registradores
export const REG_SWEEP_INICIO = 0x00;    // u64, Hz
export const REG_SWEEP_PASSO = 0x10;     // u64, Hz
export const REG_SWEEP_PONTOS = 0x20;    // u16
export const REG_VALORES_POR_F = 0x22;   // u16
export const REG_FIFO = 0x30;

export const REG_VARIANTE = 0xf0;
export const REG_PROTOCOLO = 0xf1;
export const REG_HARDWARE = 0xf2;
export const REG_FW_MAIOR = 0xf3;
export const REG_FW_MENOR = 0xf4;

// -------------------------------------------------------------- constantes
export const RESPOSTA_INDICATE_V2 = 0x32;
export const VARIANTE_V2 = 0x02;

export const BYTES_POR_VALOR = 32;

/* A contagem do comando LE_FIFO cabe em UM byte. Acima disso é preciso ler em
   blocos. O driver do ndtmwscanner escrevia `points` direto aqui e quebrava
   silenciosamente acima de 255 pontos. */
export const MAX_POR_LEITURA = 255;

/* Bloco padrão: 32 valores. Foi o tamanho validado na bancada e mantém a
   latência baixa sem encher o buffer do aparelho. */
export const BLOCO_PADRAO = 32;

export const F_MIN_HZ = 50e3;
export const F_MAX_HZ = 6.3e9;

/* Teto MEDIDO pela sonda em 2026-08-14, não o teto do registrador. O
   registrador é u16, mas com 1601 pontos o firmware devolveu 17 pontos sem
   dado; com 1024 devolveu a grade inteira. Ver docs/PROTOCOLO.md §4. */
export const PONTOS_MAX = 1024;

// ------------------------------------------------------------------ montagem
export function cmdLe(addr, n) {
  const op = { 1: LE1, 2: LE2, 4: LE4 }[n];
  return Uint8Array.from([op, addr]);
}

export function cmdEscreve(addr, valor, n) {
  const op = { 1: ESCREVE1, 2: ESCREVE2, 4: ESCREVE4, 8: ESCREVE8 }[n];
  const b = new Uint8Array(2 + n);
  b[0] = op; b[1] = addr;
  const dv = new DataView(b.buffer);
  // O registrador de frequência é u64: 3 GHz não cabe em 32 bits, e um
  // truncamento silencioso poria o aparelho em outra banda.
  if (n === 8) dv.setBigUint64(2, BigInt(Math.round(valor)), true);
  else if (n === 4) dv.setUint32(2, valor >>> 0, true);
  else if (n === 2) dv.setUint16(2, valor & 0xffff, true);
  else b[2] = valor & 0xff;
  return b;
}

/** Zera a FIFO de valores. Escrever qualquer coisa em 0x30 limpa. */
export function cmdLimpaFifo() {
  return Uint8Array.from([ESCREVE1, REG_FIFO, 0x00]);
}

/** Lê `n` valores da FIFO. `n` não pode passar de MAX_POR_LEITURA. */
export function cmdLeFifo(n) {
  if (!(n >= 1 && n <= MAX_POR_LEITURA)) {
    throw new RangeError("bloco de " + n + " fora de 1.." + MAX_POR_LEITURA);
  }
  return Uint8Array.from([LE_FIFO, REG_FIFO, n]);
}

/** Oito NOPs. Tira o aparelho de um estado meio-comando após um erro. */
export function cmdSincroniza() {
  return new Uint8Array(8);
}

/** Todos os registradores de varredura em uma escrita só. */
export function cmdVarredura(inicioHz, passoHz, pontos, valoresPorF = 1) {
  return junta([
    cmdEscreve(REG_SWEEP_INICIO, inicioHz, 8),
    cmdEscreve(REG_SWEEP_PASSO, passoHz, 8),
    cmdEscreve(REG_SWEEP_PONTOS, pontos, 2),
    cmdEscreve(REG_VALORES_POR_F, valoresPorF, 2),
  ]);
}

export function junta(partes) {
  let n = 0;
  for (const p of partes) n += p.length;
  const b = new Uint8Array(n);
  let o = 0;
  for (const p of partes) { b.set(p, o); o += p.length; }
  return b;
}

// --------------------------------------------------------------- desmontagem
/**
 * Desmonta um bloco cru da FIFO.
 *
 * Devolve `{idx, s11, s21}`. A divisão por fwd0 é a normalização de referência
 * do próprio aparelho: ela remove a variação de potência do gerador com a
 * frequência. `fwd0` nulo significa referência perdida naquele ponto; ali sai
 * NaN em vez de estouro, e o resto da varredura continua válido.
 */
export function analisaFifo(bytes) {
  const n = Math.floor(bytes.length / BYTES_POR_VALOR);
  if (bytes.length % BYTES_POR_VALOR) {
    throw new Error("bloco de " + bytes.length + " bytes não é múltiplo de "
      + BYTES_POR_VALOR);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idx = new Int32Array(n);
  const s11 = complexo(n);
  const s21 = complexo(n);
  for (let k = 0; k < n; k++) {
    const o = k * BYTES_POR_VALOR;
    const fr = dv.getInt32(o, true), fi = dv.getInt32(o + 4, true);
    const ar = dv.getInt32(o + 8, true), ai = dv.getInt32(o + 12, true);
    const br = dv.getInt32(o + 16, true), bi = dv.getInt32(o + 20, true);
    idx[k] = dv.getUint16(o + 24, true);
    const d = fr * fr + fi * fi;
    if (d === 0) {
      s11.re[k] = NaN; s11.im[k] = NaN; s21.re[k] = NaN; s21.im[k] = NaN;
      continue;
    }
    s11.re[k] = (ar * fr + ai * fi) / d;
    s11.im[k] = (ai * fr - ar * fi) / d;
    s21.re[k] = (br * fr + bi * fi) / d;
    s21.im[k] = (bi * fr - br * fi) / d;
  }
  return { idx: idx, s11: s11, s21: s21 };
}

/** Grade de frequências da varredura, em Hz. */
export function gradeF(inicioHz, passoHz, pontos) {
  const v = new Float64Array(pontos);
  for (let i = 0; i < pontos; i++) v[i] = inicioHz + passoHz * i;
  return v;
}

/** Passo inteiro em Hz. O registrador é u64: o passo tem de ser inteiro. */
export function passoDe(inicioHz, fimHz, pontos) {
  if (pontos < 2) return 0;
  return Math.round((fimHz - inicioHz) / (pontos - 1));
}
