/* Bancada simulada: um LiteVNA64 que não existe.
 *
 * DECISÃO DE PROJETO, herdada de `mwflow/vna/simulador.py`. Isto não é um
 * gerador de dados; é uma **porta serial falsa**. Ela recebe os mesmos bytes
 * que o aparelho receberia, interpreta os mesmos comandos e devolve registros
 * de FIFO de 32 bytes de verdade. Com isso o driver roda inteiro por cima
 * dela — codificação de comando, leitura em blocos, `freqIndex`,
 * ressincronismo. Um gerador de dados testaria só a física; esta porta falsa
 * testa o driver.
 *
 * POR QUE ELA IMPORTA MAIS AQUI DO QUE NO PYTHON. A página publicada é aberta
 * por quem não tem um LiteVNA na mão, e por quem usa Firefox ou Safari, onde o
 * WebSerial não existe. Sem a bancada simulada essa pessoa vê uma tela morta e
 * conclui que o programa está quebrado.
 *
 * NÚMEROS DO RESSOADOR. Os valores abaixo são redondos e genéricos, de
 * propósito. Os do ressoador real da bancada moram só na versão em Python, que
 * não é publicada: aquele sensor aguarda depósito no INPI, e uma constante num
 * arquivo público é divulgação.
 *
 * REGRA DE SEGURANÇA. `info().variante` devolve `"simulado"`, e esse rótulo
 * desce para toda linha gravada e todo arquivo exportado. Dado simulado tem de
 * ser incapaz de virar número de artigo por engano.
 */

"use strict";

import * as p from "./protocolo.js";
import { geradorComSemente, normal } from "./num.js";

export const F0_PADRAO = 1.5e9;
export const Q_PADRAO = 10.0;
export const IL_PADRAO = -30.0;
export const RMS_PADRAO = 1.2e-3;

export const TAXA_PADRAO = 270.0;      // valores por segundo, medidos na bancada
export const FWD_CONTAGENS = 1.0e6;    // amplitude da referência, em contagens

export const DUTS = ["ressoador", "aberto", "curto", "carga", "thru",
                     "isolamento", "atenuador:10"];

/** (S11, S21) verdadeiros do dispositivo sob teste, num ponto de frequência. */
function respostaDut(f, dut, f0, q, ilDb) {
  if (dut.startsWith("atenuador")) {
    const db = dut.includes(":") ? parseFloat(dut.split(":")[1]) : 10.0;
    const a = Math.pow(10, -db / 20);
    return [0.02, 0, a, 0];
  }
  const w = 2 * Math.PI * f;
  if (dut === "aberto") {
    // capacitância de franja de um aberto SMA típico: 50 fF
    const z = w * 50e-15 * 50.0;                 // imaginário puro: j·z
    const d = 1 + z * z;
    return [(1 - z * z) / d, -2 * z / d, 0, 0];
  }
  if (dut === "curto") {
    const z = w * 20e-12 / 50.0;                 // imaginário puro: j·z
    const d = 1 + z * z;
    return [(z * z - 1) / d, 2 * z / d, 0, 0];
  }
  if (dut === "carga" || dut === "isolamento") return [0.003, 0, 0, 0];
  if (dut === "thru") {
    const fi = -2 * Math.PI * f * 30e-12;
    return [0.02, 0, Math.cos(fi), Math.sin(fi)];
  }
  // ressoador: um polo, o MESMO modelo que `ajuste.js` ajusta
  const fundo = Math.pow(10, -60 / 20);
  const pico = Math.pow(10, ilDb / 20);
  const amp = pico - fundo;
  const x = 2 * q * (f - f0) / f0;
  const d = 1 + x * x;
  const lr = 1 / d, li = -x / d;                 // 1/(1 + j·x)
  return [0.92 - 0.75 * lr, -0.75 * li, fundo + amp * lr, amp * li];
}

/** Caixa de erro sintética: (e00, e11, e10e01, e30, e10e32, e22) num ponto. */
function caixaErro(f, ideal, faseIso) {
  if (ideal) return [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const tau = 1.0e-9;                            // atraso de cabo, 1 ns
  const a = -2 * Math.PI * f * tau;
  const rr = Math.cos(a), ri = Math.sin(a);      // rot = exp(-j·2π·f·τ)
  const b = 2 * Math.PI * f / 1.5e9;
  const e00r = 0.02 * Math.cos(b) + 0.005, e00i = 0.02 * Math.sin(b);
  const e11r = 0.10 * rr, e11i = 0.10 * ri;
  const r2r = rr * rr - ri * ri, r2i = 2 * rr * ri;   // rot²
  const trr = 0.95 * r2r, tri = 0.95 * r2i;
  const iso = Math.pow(10, -85 / 20);
  const e30r = iso * Math.cos(faseIso), e30i = iso * Math.sin(faseIso);
  const t32r = 0.90 * rr, t32i = 0.90 * ri;
  const e22r = 0.08 * rr, e22i = 0.08 * ri;
  return [e00r, e00i, e11r, e11i, trr, tri, e30r, e30i, t32r, t32i, e22r, e22i];
}

/** Divisão complexa a/b, devolvida como par. */
function divide(ar, ai, br, bi) {
  const d = br * br + bi * bi;
  return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
}

export class PortaSimulada {
  constructor(opcoes = {}) {
    this.simulado = true;
    this.aberta = true;
    this.dut = opcoes.dut || "ressoador";
    this.turbo = !!opcoes.turbo;
    this.ideal = !!opcoes.ideal;
    this.deriva = opcoes.deriva !== false;
    this.padDb = Number(opcoes.padDb || 0);
    this.f0 = Number(opcoes.f0 || F0_PADRAO);
    this.q = Number(opcoes.q || Q_PADRAO);
    this.ilDb = Number(opcoes.ilDb === undefined ? IL_PADRAO : opcoes.ilDb);
    this.rng = geradorComSemente(opcoes.semente || 7);
    this.faseIso = 2 * Math.PI * this.rng();

    this._saida = [];
    this._total = 0;
    this._entrada = [];
    this._reg = {};
    this._reg[p.REG_VARIANTE] = 0x02;
    this._reg[p.REG_PROTOCOLO] = 1;
    this._reg[p.REG_HARDWARE] = 2;
    this._reg[p.REG_FW_MAIOR] = 2;
    this._reg[p.REG_FW_MENOR] = 2;
    this._inicio = 0;
    this._passo = 0;
    this._pontos = 101;
    this._vpf = 1;
    this._idx = 0;
    this._t0 = Date.now() / 1000;
    this._prontoEm = 0;
  }

  async abre() { this.aberta = true; return this; }
  async fecha() { this.aberta = false; }

  limpaEntrada() {
    this._saida.length = 0;
    this._total = 0;
  }

  async escreve(bytes) {
    for (let i = 0; i < bytes.length; i++) this._entrada.push(bytes[i]);
    this._processa();
  }

  async leExato(n, prazoMs) {
    // O aparelho real leva tempo para produzir os valores. Sem esta espera o
    // laço do motor giraria a milhares de varreduras por segundo e a interface
    // mostraria uma taxa que nenhum LiteVNA alcança.
    const espera = this._prontoEm - Date.now();
    if (espera > 0) {
      await new Promise((ok) => setTimeout(ok, Math.min(espera, prazoMs)));
    }
    return this._retira(Math.min(n, this._total));
  }

  _retira(n) {
    const saida = new Uint8Array(n);
    for (let i = 0; i < n; i++) saida[i] = this._saida[i];
    this._saida.splice(0, n);
    this._total -= n;
    return saida;
  }

  _emiteBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) this._saida.push(bytes[i]);
    this._total += bytes.length;
  }

  // ---------------------------------------------------- máquina de comandos
  static get TAM() {
    const t = {};
    t[p.NOP] = 1; t[p.INDICATE] = 1; t[p.LE1] = 2; t[p.LE2] = 2; t[p.LE4] = 2;
    t[p.LE_FIFO] = 3; t[p.ESCREVE1] = 3; t[p.ESCREVE2] = 4; t[p.ESCREVE4] = 6;
    t[p.ESCREVE8] = 10; t[p.ESCREVE_FIFO] = 3;
    return t;
  }

  _processa() {
    const TAM = PortaSimulada.TAM;
    while (this._entrada.length) {
      const op = this._entrada[0];
      const tam = TAM[op];
      if (tam === undefined) {
        // opcode desconhecido: o aparelho real simplesmente ignora
        this._entrada.shift();
        continue;
      }
      if (this._entrada.length < tam) return;   // comando pela metade
      const quadro = this._entrada.splice(0, tam);
      this._executa(op, quadro);
    }
  }

  _executa(op, q) {
    if (op === p.NOP) return;
    if (op === p.INDICATE) {
      this._emiteBytes([p.RESPOSTA_INDICATE_V2]);
      return;
    }
    if (op === p.LE1 || op === p.LE2 || op === p.LE4) {
      const n = op === p.LE1 ? 1 : (op === p.LE2 ? 2 : 4);
      const v = this._reg[q[1]] || 0;
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (v >> (8 * i)) & 0xff;
      this._emiteBytes(b);
      return;
    }
    if (op === p.ESCREVE1 || op === p.ESCREVE2 || op === p.ESCREVE4
        || op === p.ESCREVE8) {
      const n = { [p.ESCREVE1]: 1, [p.ESCREVE2]: 2, [p.ESCREVE4]: 4,
                  [p.ESCREVE8]: 8 }[op];
      const addr = q[1];
      let val = 0;
      for (let i = n - 1; i >= 0; i--) val = val * 256 + q[2 + i];
      if (addr === p.REG_SWEEP_INICIO) this._inicio = val;
      else if (addr === p.REG_SWEEP_PASSO) this._passo = val;
      else if (addr === p.REG_SWEEP_PONTOS) this._pontos = Math.max(1, val);
      else if (addr === p.REG_VALORES_POR_F) this._vpf = Math.max(1, val);
      else if (addr === p.REG_FIFO) this._idx = 0;   // limpar reinicia o ciclo
      // os registradores de varredura leem zero neste firmware
      return;
    }
    if (op === p.LE_FIFO) {
      this._emite(q[2]);
      return;
    }
  }

  // ------------------------------------------------------------- geração
  _emite(n) {
    if (!this.turbo) {
      const agora = Date.now();
      const base = Math.max(agora, this._prontoEm);
      this._prontoEm = base + (n / TAXA_PADRAO) * 1000;
    }
    let f0 = this.f0;
    if (this.deriva) {
      const t = Date.now() / 1000 - this._t0;
      f0 += 2.0e6 * Math.sin(2 * Math.PI * t / 180.0);
    }
    const aPad = Math.pow(10, -this.padDb / 20);
    const sig = RMS_PADRAO * FWD_CONTAGENS / Math.SQRT2;

    const b = new Uint8Array(n * p.BYTES_POR_VALOR);
    const dv = new DataView(b.buffer);
    for (let k = 0; k < n; k++) {
      const idx = (this._idx + k) % this._pontos;
      const f = this._inicio + this._passo * idx;
      let [s11r, s11i, s21r, s21i] = respostaDut(f, this.dut, f0, this.q,
                                                 this.ilDb);
      const e = caixaErro(f, this.ideal, this.faseIso);
      // O atenuador da porta 2 fica ENTRE o dispositivo e a porta: ele atenua
      // o sinal uma vez e a onda refletida de volta outra vez, então o
      // descasamento visto pela porta 2 melhora pelo dobro do valor em dB.
      const e22r = e[10] * aPad * aPad, e22i = e[11] * aPad * aPad;
      s21r *= aPad; s21i *= aPad;

      // gm = e00 + e10e01·s11 / (1 − e11·s11)
      const um11r = 1 - (e[2] * s11r - e[3] * s11i);
      const um11i = -(e[2] * s11i + e[3] * s11r);
      const nr = e[4] * s11r - e[5] * s11i, ni = e[4] * s11i + e[5] * s11r;
      const [qr, qi] = divide(nr, ni, um11r, um11i);
      const gmr = e[0] + qr, gmi = e[1] + qi;

      // tm = e30 + e10e32·s21 / ((1 − e11·s11)(1 − e22·s11))
      const um22r = 1 - (e22r * s11r - e22i * s11i);
      const um22i = -(e22r * s11i + e22i * s11r);
      const denr = um11r * um22r - um11i * um22i;
      const deni = um11r * um22i + um11i * um22r;
      const tr = e[8] * s21r - e[9] * s21i, ti = e[8] * s21i + e[9] * s21r;
      const [ur, ui] = divide(tr, ti, denr, deni);
      const tmr = e[6] + ur, tmi = e[7] + ui;

      const fwdr = FWD_CONTAGENS + normal(this.rng) * sig;
      const fwdi = normal(this.rng) * sig;
      const rev0r = gmr * FWD_CONTAGENS + normal(this.rng) * sig;
      const rev0i = gmi * FWD_CONTAGENS + normal(this.rng) * sig;
      const rev1r = tmr * FWD_CONTAGENS + normal(this.rng) * sig;
      const rev1i = tmi * FWD_CONTAGENS + normal(this.rng) * sig;

      const o = k * p.BYTES_POR_VALOR;
      dv.setInt32(o, fwdr | 0, true);
      dv.setInt32(o + 4, fwdi | 0, true);
      dv.setInt32(o + 8, rev0r | 0, true);
      dv.setInt32(o + 12, rev0i | 0, true);
      dv.setInt32(o + 16, rev1r | 0, true);
      dv.setInt32(o + 20, rev1i | 0, true);
      dv.setUint16(o + 24, idx, true);
    }
    this._idx = (this._idx + n) % this._pontos;
    this._emiteBytes(b);
  }
}
