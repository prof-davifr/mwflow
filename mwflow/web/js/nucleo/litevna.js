/* Driver do LiteVNA64 — gêmeo de `mwflow/vna/litevna.py`.
 *
 * A diferença de fundo entre os dois: lá as leituras da serial são bloqueantes
 * dentro de uma thread; aqui são `await` dentro do laço de eventos do
 * navegador. A ordem das operações é a mesma, e as duas armadilhas do
 * aparelho continuam tratadas do mesmo jeito:
 *
 * 1. `LE_FIFO` tem contagem de UM byte. Acima de 255 valores é obrigatório ler
 *    em blocos. O driver de onde este veio não fazia isso e devolvia lixo.
 * 2. Os vetores nascem a cada varredura, e não uma vez só. Um vetor
 *    reaproveitado não redimensiona quando `pontos` muda.
 */

"use strict";

import * as p from "./protocolo.js";
import { complexo } from "./num.js";

export class ErroVNA extends Error {}

/** A aquisição foi interrompida a pedido, entre dois blocos da FIFO.
 *
 *  Não é erro. Uma varredura abortada é descartada inteira: entregar meia
 *  varredura corromperia o ajuste em silêncio. */
export class Abortado extends Error {}

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

export class LiteVNA {
  static nome = "LiteVNA64";

  constructor(porta, bloco = p.BLOCO_PADRAO, tentativas = 3) {
    this.porta = porta;
    this.bloco = Math.min(bloco, p.MAX_POR_LEITURA);
    this.tentativas = tentativas;
    this.simulado = !!(porta && porta.simulado);
    // Bandeira opcional. Quando o motor a levanta, a leitura em curso para no
    // fim do bloco atual, e não no fim da varredura. Com 1024 pontos a
    // diferença é entre 0,1 s e 3,4 s de espera para trocar de banda.
    this.abortar = { ativo: false };
    this.inicioHz = 0;
    this.passoHz = 0;
    this.pontos = 0;
    this.valoresPorF = 1;
  }

  // ------------------------------------------------------- ciclo de vida
  async abre() {
    await this.porta.abre();
    await this.ressincroniza();
    return this;
  }

  async fecha() {
    if (this.porta) await this.porta.fecha();
  }

  get aberto() {
    return !!(this.porta && this.porta.aberta);
  }

  // --------------------------------------------------------- baixo nível
  /** Devolve o aparelho a um estado conhecido depois de um erro.
   *
   *  Oito NOPs fecham qualquer comando pela metade; o descarte da entrada joga
   *  fora os bytes órfãos que ainda estavam a caminho. No Linux o
   *  ModemManager sonda portas CDC-ACM com comandos AT logo depois do plugue,
   *  e esses bytes caem no interpretador binário do LiteVNA. */
  async ressincroniza() {
    this.porta.limpaEntrada();
    await this.porta.escreve(p.cmdSincroniza());
    await espera(50);
    this.porta.limpaEntrada();
  }

  async _leReg(addr, n) {
    await this.porta.escreve(p.cmdLe(addr, n));
    const d = await this.porta.leExato(n, 1000);
    if (d.length !== n) {
      throw new ErroVNA("registrador 0x" + addr.toString(16)
        + ": li " + d.length + " de " + n + " bytes");
    }
    let v = 0;
    for (let i = n - 1; i >= 0; i--) v = v * 256 + d[i];
    return v;
  }

  /** Confirma que do outro lado há mesmo um aparelho da família V2. */
  async confere() {
    this.porta.limpaEntrada();
    await this.porta.escreve(Uint8Array.from([p.INDICATE]));
    const r = await this.porta.leExato(1, 1000);
    if (!r.length) {
      throw new ErroVNA("INDICATE sem resposta — o aparelho fala o protocolo "
        + "de texto? (o LiteVNA usa o binário V2)");
    }
    if (r[0] !== p.RESPOSTA_INDICATE_V2) {
      throw new ErroVNA("INDICATE devolveu 0x" + r[0].toString(16)
        + ", esperava 0x" + p.RESPOSTA_INDICATE_V2.toString(16));
    }
    return true;
  }

  /** Identificação do aparelho. */
  async info() {
    await this.abre();
    await this.confere();
    return {
      porta: this.simulado ? "simulado" : "WebSerial",
      variante: this.simulado ? "simulado" : await this._leReg(p.REG_VARIANTE, 1),
      protocolo: await this._leReg(p.REG_PROTOCOLO, 1),
      hardware: await this._leReg(p.REG_HARDWARE, 1),
      firmware: (await this._leReg(p.REG_FW_MAIOR, 1)) + "."
        + (await this._leReg(p.REG_FW_MENOR, 1)),
    };
  }

  // -------------------------------------------------------- configuração
  /** Escreve os registradores de varredura e limpa a FIFO.
   *
   *  Ler de volta 0x00/0x10/0x20 devolve zero neste firmware. Não é falha:
   *  esses registradores só valem depois que o host escreve. Por isso o estado
   *  fica guardado aqui, e não no aparelho. */
  async configura(inicioHz, passoHz, pontos, valoresPorF = 1) {
    pontos = Math.round(pontos);
    if (!(pontos >= 1 && pontos <= p.PONTOS_MAX)) {
      throw new RangeError("pontos fora de 1.." + p.PONTOS_MAX);
    }
    const fim = inicioHz + passoHz * (pontos - 1);
    for (const f of [inicioHz, fim]) {
      if (!(f >= p.F_MIN_HZ && f <= p.F_MAX_HZ)) {
        throw new RangeError(
          (f / 1e6).toFixed(3) + " MHz fora da faixa do LiteVNA64 ("
          + (p.F_MIN_HZ / 1e3) + " kHz a " + (p.F_MAX_HZ / 1e9).toFixed(3)
          + " GHz)");
      }
    }
    this.inicioHz = inicioHz;
    this.passoHz = passoHz;
    this.pontos = pontos;
    this.valoresPorF = valoresPorF;

    await this.porta.escreve(p.cmdVarredura(inicioHz, passoHz, pontos,
                                            valoresPorF));
    // o aparelho reinicia a varredura; dá um tempo antes de limpar a FIFO
    await espera(50);
    await this.limpaFifo();
    return this;
  }

  /** Configura por início e fim, em vez de início e passo. */
  async defineVarredura(inicioHz, fimHz, pontos, valoresPorF = 1) {
    return this.configura(inicioHz, p.passoDe(inicioHz, fimHz, pontos), pontos,
                          valoresPorF);
  }

  /** Modo de frequência fixa: passo nulo.
   *
   *  Com o passo em zero todos os pontos caem na mesma frequência, e cada
   *  registro da FIFO vira uma amostra no tempo. É o que alimenta a tela do
   *  osciloscópio. */
  async defineCw(fHz, bloco = null, valoresPorF = 1) {
    return this.configura(fHz, 0, bloco || this.bloco, valoresPorF);
  }

  async limpaFifo() {
    this.porta.limpaEntrada();
    await this.porta.escreve(p.cmdLimpaFifo());
  }

  frequencias() {
    return p.gradeF(this.inicioHz, this.passoHz, this.pontos);
  }

  // ------------------------------------------------------------ aquisição
  /** Folga generosa: 2 s de partida mais 20 ms por valor. */
  _prazoDe(n) {
    return 2000 + 20 * n * Math.max(1, this.valoresPorF);
  }

  async _leBloco(n) {
    await this.porta.escreve(p.cmdLeFifo(n));
    const esperado = n * p.BYTES_POR_VALOR;
    const buf = await this.porta.leExato(esperado, this._prazoDe(n));
    if (buf.length !== esperado) {
      throw new ErroVNA("FIFO curta: " + buf.length + " de " + esperado
        + " bytes (" + n + " valores)");
    }
    return p.analisaFifo(buf);
  }

  /** Lê `total` valores em blocos, respeitando o limite de 1 byte. */
  async _leN(total) {
    const idx = new Int32Array(total);
    const s11 = complexo(total);
    const s21 = complexo(total);
    let posto = 0;
    while (posto < total) {
      if (this.abortar && this.abortar.ativo) {
        throw new Abortado("leitura interrompida com " + posto + " de " + total);
      }
      const n = Math.min(this.bloco, total - posto);
      const r = await this._leBloco(n);
      idx.set(r.idx, posto);
      s11.re.set(r.s11.re, posto); s11.im.set(r.s11.im, posto);
      s21.re.set(r.s21.re, posto); s21.im.set(r.s21.im, posto);
      posto += n;
    }
    return { idx: idx, s11: s11, s21: s21 };
  }

  /** Executa uma leitura; em falha, ressincroniza e tenta de novo. */
  async _comRetentativa(funcao) {
    let ultimo = null;
    for (let t = 0; t < this.tentativas; t++) {
      try {
        return await funcao();
      } catch (e) {
        if (e instanceof Abortado) throw e;
        if (!(e instanceof ErroVNA)) throw e;
        ultimo = e;
        if (t + 1 < this.tentativas) {
          await this.ressincroniza();
          await this.limpaFifo();
          await espera(100);
        }
      }
    }
    throw new ErroVNA("falhou após " + this.tentativas + " tentativas: "
      + (ultimo && ultimo.message));
  }

  /**
   * Uma varredura completa. Devolve `{f, s11, s21}`.
   *
   * A varredura do aparelho é cíclica. Ao ler `pontos` valores a partir de um
   * lugar qualquer do ciclo, cada índice de frequência aparece uma vez — por
   * isso o resultado é espalhado pelo `freqIndex`, e não pela ordem de
   * chegada. Se algum índice faltar, o ponto sai NaN em vez de vir de outra
   * varredura.
   *
   * Com `valoresPorF` acima de 1 é preciso ler `pontos · valoresPorF`
   * registros e promediar por índice: a sonda mostrou que o aparelho emite um
   * registro por valor e NÃO promedia por dentro.
   */
  async varre() {
    const n = this.pontos;
    const v = Math.max(1, this.valoresPorF);
    const r = await this._comRetentativa(async () => {
      await this.limpaFifo();
      return this._leN(n * v);
    });

    const conta = new Float64Array(n);
    const s11 = complexo(n);
    const s21 = complexo(n);
    for (let k = 0; k < r.idx.length; k++) {
      const i = r.idx[k];
      if (i < 0 || i >= n) continue;
      conta[i] += 1;
      s11.re[i] += r.s11.re[k]; s11.im[i] += r.s11.im[k];
      s21.re[i] += r.s21.re[k]; s21.im[i] += r.s21.im[k];
    }
    for (let i = 0; i < n; i++) {
      const c = conta[i] || NaN;      // 0/0 vira NaN, e não divisão por zero
      s11.re[i] /= c; s11.im[i] /= c;
      s21.re[i] /= c; s21.im[i] /= c;
    }
    return { f: this.frequencias(), s11: s11, s21: s21 };
  }

  /**
   * Média de `m` varreduras. Devolve `{f, s11, s21, desvio}`.
   *
   * A média é feita aqui, e não pelo registrador `valoresPorF` do aparelho:
   * assim o número de varreduras somadas é conhecido e o desvio sai junto, que
   * é o que a tela de calibração precisa.
   */
  async varreMedia(m = 1) {
    m = Math.max(1, Math.round(m));
    const primeira = await this.varre();
    if (m === 1) {
      return { f: primeira.f, s11: primeira.s11, s21: primeira.s21,
               desvio: new Float64Array(primeira.f.length) };
    }
    const n = primeira.f.length;
    const acc11 = complexo(n), acc21 = complexo(n);
    const c11 = new Float64Array(n), c21 = new Float64Array(n);
    const mods = [];
    // Média que ignora ponto sem dado, como o `np.nanmean` do lado do Python.
    // Um único NaN numa das varreduras não pode apagar o ponto na média.
    const soma = (dst, cnt, z) => {
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(z.re[i]) || !Number.isFinite(z.im[i])) continue;
        dst.re[i] += z.re[i]; dst.im[i] += z.im[i]; cnt[i] += 1;
      }
    };
    const modulo = (z) => {
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) v[i] = Math.hypot(z.re[i], z.im[i]);
      return v;
    };
    soma(acc11, c11, primeira.s11); soma(acc21, c21, primeira.s21);
    mods.push(modulo(primeira.s21));
    for (let k = 1; k < m; k++) {
      const r = await this.varre();
      soma(acc11, c11, r.s11); soma(acc21, c21, r.s21);
      mods.push(modulo(r.s21));
    }
    for (let i = 0; i < n; i++) {
      const a = c11[i] || NaN, b = c21[i] || NaN;
      acc11.re[i] /= a; acc11.im[i] /= a;
      acc21.re[i] /= b; acc21.im[i] /= b;
    }
    const desvio = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, q = 0, c = 0;
      for (let k = 0; k < m; k++) {
        const v = mods[k][i];
        if (Number.isFinite(v)) { s += v; q += v * v; c++; }
      }
      desvio[i] = c ? Math.sqrt(Math.max(0, q / c - (s / c) * (s / c))) : NaN;
    }
    return { f: primeira.f, s11: acc11, s21: acc21, desvio: desvio };
  }

  /**
   * `n` amostras no tempo, na frequência fixa já configurada.
   *
   * Em modo CW o `freqIndex` não distingue nada — todos os pontos estão na
   * mesma frequência. Aqui vale a ordem de chegada, e não o índice.
   */
  async amostrasCw(n) {
    const largura = Math.abs(this.passoHz) * Math.max(1, this.pontos - 1);
    if (largura > 1e-6 * Math.max(this.inicioHz, 1)) {
      throw new ErroVNA("amostrasCw exige frequência fixa: a grade atual cobre "
        + largura.toFixed(3) + " Hz. Chame defineCw antes.");
    }
    const r = await this._comRetentativa(() => this._leN(n));
    return { s11: r.s11, s21: r.s21 };
  }
}
