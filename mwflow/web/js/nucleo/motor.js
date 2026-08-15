/* Motor de aquisição no navegador — gêmeo de `mwflow/motor.py`.
 *
 * A DIFERENÇA DE FUNDO. No Python uma thread do sistema é dona da porta serial
 * e roda um laço bloqueante; o asyncio cuida dos sockets. Aqui não há thread
 * nem socket: o laço é uma função `async` e as entregas são chamadas diretas.
 * Some a fila entre produtor e consumidor, e com ela some a política de
 * descarte de quadro — não há como o consumidor ficar para trás quando ele é
 * uma chamada síncrona.
 *
 * O QUE **NÃO** MUDA, porque é o que garante a medida:
 *
 * 1. Toda leitura da serial tem prazo.
 * 2. Comando de reconfiguração só é consumido ENTRE aquisições completas. Uma
 *    varredura abortada é descartada inteira — entregar meia varredura
 *    corromperia o ajuste em silêncio.
 * 3. Os padrões SOLT são medidos SEM correção. Aplicar a calibração velha em
 *    cima deles produziria calibração encadeada, que é lixo.
 * 4. No armazenamento vai o BRUTO. A correção é da leitura.
 */

"use strict";

import * as ob from "./observaveis.js";
import * as solt from "./solt.js";
import * as az from "./armazenamento.js";
import { Abortado } from "./litevna.js";
import { PONTOS_MAX } from "./protocolo.js";
import { ajustaPolinomio, desvio, media } from "./num.js";

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

function _num(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function _limpa(d) {
  const s = {};
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith("_")) continue;
    s[k] = _num(v);
  }
  return s;
}

/**
 * Reconstrói o instante de cada amostra em modo de frequência fixa.
 *
 * O aparelho entrega amostras a um ritmo constante, mas o USB entrega os lotes
 * com tremor. Se o eixo do tempo usar o instante de chegada, o osciloscópio
 * mostra ±10 ms de ruído que não existe. Então ajusta-se `t = a·n + b` por
 * mínimos quadrados sobre os últimos lotes, e usa-se a reta.
 */
export class BaseTempo {
  constructor(janela = 40) {
    this.janela = janela;
    this.pontos = [];
    this.a = 1.0 / 270.0;
    this.b = 0.0;
  }

  zera() { this.pontos.length = 0; }

  registra(nAcumulado, tChegada) {
    this.pontos.push([nAcumulado, tChegada]);
    if (this.pontos.length > this.janela) this.pontos.shift();
    if (this.pontos.length >= 3) {
      const x = Float64Array.from(this.pontos, (q) => q[0]);
      const y = Float64Array.from(this.pontos, (q) => q[1]);
      const r = ajustaPolinomio(x, y, 1);
      if (r && r.coefs[0] > 0) { this.a = r.coefs[0]; this.b = r.coefs[1]; }
    } else if (this.pontos.length) {
      this.b = tChegada - this.a * nAcumulado;
    }
  }

  get taxa() { return this.a > 0 ? 1 / this.a : NaN; }

  instantes(n0, n) {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = this.a * (n0 + i) + this.b;
    return v;
  }
}

export class Motor {
  constructor(vna) {
    this.vna = vna;
    this.simulado = !!(vna && vna.simulado);
    this._cmds = [];
    this._parar = false;
    this._abortar = { ativo: false };
    if (this.vna) this.vna.abortar = this._abortar;
    this._assinantes = [];

    // configuração corrente
    this.modo = "parado";
    this.f_inicio = 50e6;
    this.f_fim = 3e9;
    this.pontos = 401;
    this.vpf = 1;
    this.medias = 1;
    this.f_cw = 1.5e9;
    this.bloco_cw = 64;
    this.geracao = 0;

    // observável derivado
    this.param = "s21";
    this.banda = [1.30e9, 2.00e9];
    this.portoes = new ob.Portoes();

    // estado observado
    this.identidade = null;
    this.seq = 0;
    this.taxa_pontos = NaN;
    this.taxa_varreduras = NaN;
    this.ultimo_erro = null;
    this.base = new BaseTempo();
    this._n_cw = 0;
    this.correcao = null;

    // gravação e captura
    this.sessao = null;
    this.gravando = false;
    this._captura = null;
    this._ultima = null;

    // calibração
    this.cal_medidas = {};
    this._cal_pedido = null;
    this.cal_nome = null;
    this.cal_modo = "inicial";
    this._cal_ini = null;
    this._cal_fim = null;
    this._cal_t0 = null;
    this._cal_t1 = null;
    this._termos_grade = null;
  }

  // ------------------------------------------------------------ assinatura
  assina(topicos, entrega) {
    const a = { topicos: new Set(topicos), entrega: entrega, vivo: true,
                quedas: {} };
    this._assinantes.push(a);
    return a;
  }

  desassina(a) {
    a.vivo = false;
    const i = this._assinantes.indexOf(a);
    if (i >= 0) this._assinantes.splice(i, 1);
  }

  _publica(msg) {
    for (const a of this._assinantes.slice()) {
      if (!a.vivo || !a.topicos.has(msg.tipo)) continue;
      try {
        a.entrega(msg);
      } catch (e) {
        console.error("assinante falhou:", e);
      }
    }
  }

  // ------------------------------------------------------------- comandos
  comanda(cmd) {
    this._cmds.push(cmd);
    // Trocar de banda ou de modo aborta a varredura em curso; os demais
    // comandos esperam ela terminar.
    if (["configurar", "modo", "parar"].includes(cmd.t)) {
      this._abortar.ativo = true;
    }
    return true;
  }

  _aplicaComandos() {
    let mudou = false;
    while (this._cmds.length) {
      const c = this._cmds.shift();
      const t = c.t;
      if (t === "configurar") {
        if (c.f_inicio_hz !== undefined) this.f_inicio = Number(c.f_inicio_hz);
        if (c.f_fim_hz !== undefined) this.f_fim = Number(c.f_fim_hz);
        if (c.n_pontos !== undefined) this.pontos = Math.round(c.n_pontos);
        if (c.vpf !== undefined) this.vpf = Math.max(1, Math.round(c.vpf));
        if (c.medias !== undefined) this.medias = Math.max(1, Math.round(c.medias));
        mudou = true;
      } else if (t === "modo") {
        if (c.modo) this.modo = c.modo;
        if (c.f_cw_hz) this.f_cw = Number(c.f_cw_hz);
        if (c.banda_hz) this.banda = c.banda_hz.map(Number);
        mudou = true;
      } else if (t === "iniciar") {
        if (this.modo === "parado") this.modo = "varredura";
        mudou = true;
      } else if (t === "parar") {
        this.modo = "parado";
        mudou = true;
      } else if (t === "observavel") {
        if (c.param) this.param = c.param;
        if (c.banda_hz) this.banda = c.banda_hz.map(Number);
        this.portoes.reinicia();
      } else if (t === "portoes") {
        for (const k of ["rms_max", "q_min", "q_max", "salto_max_hz",
                         "banda_adaptativa", "k_banda"]) {
          if (k in c) this.portoes[k] = c[k];
        }
        this.portoes.reinicia();
      } else if (t === "gravar") {
        this.gravando = c.ligado !== false;
      } else if (t === "capturar") {
        this._iniciaCaptura(c);
      } else if (t === "cancelar_captura") {
        this._captura = null;
      } else if (t === "salvar_varredura") {
        this._salvaUltima(c);
      } else if (t === "evento") {
        if (this.sessao) this.sessao.gravaEvento("info", "operador", c.rotulo || "");
      } else if (t === "cal_medir") {
        this._cal_pedido = { padrao: c.padrao,
                             n: Math.max(1, Math.round(c.n_medias || 16)),
                             acc: [] };
        this._publica({ tipo: "cal", estado: "medindo", padrao: c.padrao });
      } else if (t === "cal_esquecer") {
        delete this.cal_medidas[c.padrao];
        this._publica({ tipo: "cal", estado: "medidas",
                        padroes: Object.keys(this.cal_medidas).sort() });
      } else if (t === "sim_dut") {
        // Só existe na bancada simulada: troca o dispositivo sob teste sem
        // ninguém encostar num conector. É o que permite exercitar a
        // calibração inteira sem hardware.
        if (this.simulado && this.vna.porta) {
          this.vna.porta.dut = c.dut || "ressoador";
          this._publica({ tipo: "mensagem",
                          msg: "dispositivo simulado: " + this.vna.porta.dut });
        }
      }
    }
    return mudou;
  }

  // ----------------------------------------------------------- calibração
  _medePadrao(f, s11, s21) {
    const p = this._cal_pedido;
    if (!p) return;
    p.acc.push([s11, s21]);
    this._publica({ tipo: "cal", estado: "andando", padrao: p.padrao,
                    faltam: p.n - p.acc.length });
    if (p.acc.length < p.n) return;
    const n = f.length;
    const soma = (indice) => {
      const z = { re: new Float64Array(n), im: new Float64Array(n) };
      const c = new Float64Array(n);
      for (const par of p.acc) {
        const v = par[indice];
        for (let i = 0; i < n; i++) {
          if (!Number.isFinite(v.re[i]) || !Number.isFinite(v.im[i])) continue;
          z.re[i] += v.re[i]; z.im[i] += v.im[i]; c[i] += 1;
        }
      }
      for (let i = 0; i < n; i++) {
        const d = c[i] || NaN;
        z.re[i] /= d; z.im[i] /= d;
      }
      return z;
    };
    this.cal_medidas[p.padrao] = { f: Float64Array.from(f), s11: soma(0),
                                   s21: soma(1) };
    this._cal_pedido = null;
    this._publica({ tipo: "cal", estado: "medido", padrao: p.padrao,
                    padroes: Object.keys(this.cal_medidas).sort(),
                    n_medias: p.n });
  }

  /**
   * Monta a função de correção a partir dos conjuntos escolhidos.
   *
   * A correção é aplicada NA LEITURA. O que vai para o armazenamento é sempre
   * o dado bruto, então trocar de modo depois nunca destrói medida.
   */
  async aplicaCorrecao(ini = null, fim = null, modo = "inicial") {
    this._cal_ini = this._cal_fim = null;
    this._termos_grade = null;
    if (!ini) {
      this.correcao = null;
      this.cal_nome = null;
      return { estado: "bruto" };
    }
    const a = await az.carregaCal(ini);
    this._cal_ini = a.termos;
    this._cal_t0 = Date.now() / 1000;
    let aviso = null;
    if (fim && modo !== "inicial") {
      const b = await az.carregaCal(fim);
      this._cal_fim = b.termos;
      this._cal_t1 = Date.now() / 1000 + 1.0;
      const d = solt.distancia(a.termos, b.termos);
      const vals = Object.values(d);
      const pior = vals.length ? Math.max(...vals) : -99;
      if (pior > -20) {
        aviso = "os dois conjuntos diferem em " + pior.toFixed(1) + " dB. A "
          + "interpolação no tempo supõe deriva lenta; uma diferença desse "
          + "tamanho costuma ser cabo mexido. Prefira o modo 'inicial' e "
          + "marque a sessão como suspeita.";
      }
    }
    this.cal_nome = ini;
    this.cal_modo = modo;
    this.correcao = (f, s11, s21, t) => {
      const termos = this._termosPara(f, t);
      if (!termos) return { s11: s11, s21: s21 };
      return solt.corrige(termos, s11, s21);
    };
    return { estado: "aplicada", nome: ini, modo: modo, aviso: aviso,
             meta: a.meta };
  }

  /** Interpola os termos para a grade atual, e no tempo se for o caso. */
  _termosPara(f, t) {
    const chave = f[0] + "|" + f[f.length - 1] + "|" + f.length + "|" + this.cal_modo;
    if (this._termos_grade && this._termos_grade[0] === chave
        && this.cal_modo !== "interpolado") {
      return this._termos_grade[1];
    }
    let base = this._cal_ini;
    if (!base) return null;
    if (this.cal_modo === "final" && this._cal_fim) {
      base = this._cal_fim;
    } else if (this.cal_modo === "interpolado" && this._cal_fim) {
      const dur = Math.max(1e-6, (this._cal_t1 || 0) - (this._cal_t0 || 0));
      base = solt.misturaNoTempo(this._cal_ini, this._cal_fim,
                                 (t - (this._cal_t0 || t)) / dur);
    }
    let termos;
    try {
      termos = solt.interpola(base, f);
    } catch (e) {
      this._publica({ tipo: "erro", nivel: "aviso", codigo: "cal_fora",
                      msg: e.message });
      this.correcao = null;
      this.cal_nome = null;
      return null;
    }
    this._termos_grade = [chave, termos];
    return termos;
  }

  // -------------------------------------------------------------- captura
  /**
   * Junta N medidas da mesma amostra e devolve média, desvio e brutos.
   *
   * Guardar as N medidas individuais, e não só a média, é o que permite medir
   * σ por nível em vez de supor um valor — e é esse σ que vira o limite de
   * detecção.
   */
  _iniciaCaptura(c) {
    const alvo = c.obs || "derivado:f_res";
    const i = alvo.indexOf(":");
    this._captura = {
      tipo: alvo.slice(0, i), nome: alvo.slice(i + 1),
      n: Math.max(1, Math.round(c.n_med || 5)),
      f_alvo_hz: Number(c.f_alvo_hz || this.f_cw),
      // `cov` é a covariável da curva, seja ela qual for; `temperatura_c` é o
      // nome antigo do mesmo campo
      meta: { x: c.x, cov: c.cov ?? c.temperatura_c, replica: c.replica,
              ordem: c.ordem, x_ref: c.x_ref, nota: c.nota,
              curva_id: c.curva_id, obs: alvo },
      brutos: [], recusas: 0, t0: Date.now() / 1000,
    };
    this._publica({ tipo: "captura", estado: "iniciada", faltam: this._captura.n });
  }

  _acumula(valor, ok = true, motivo = null) {
    const cap = this._captura;
    if (!cap) return;
    if (!ok || valor === null || valor === undefined || !Number.isFinite(valor)) {
      cap.recusas += 1;
      if (cap.recusas > 4 * cap.n) {
        this._publica({ tipo: "captura", estado: "falhou",
                        msg: "recusas demais: " + (motivo || "") });
        this._captura = null;
      }
      return;
    }
    cap.brutos.push(Number(valor));
    this._publica({ tipo: "captura", estado: "andando",
                    faltam: cap.n - cap.brutos.length });
    if (cap.brutos.length < cap.n) return;

    const v = Float64Array.from(cap.brutos);
    const msg = Object.assign({
      tipo: "ponto", t: Date.now() / 1000,
      y: media(v), y_desvio: v.length > 1 ? desvio(v, 1) : 0.0,
      n_med: v.length, brutos: Array.from(v), recusas: cap.recusas,
    }, cap.meta);
    this._publica(msg);
    if (this.sessao) {
      this.sessao.gravaEvento("info", "ponto", JSON.stringify(
        { x: msg.x, y: msg.y, y_desvio: msg.y_desvio, n_med: msg.n_med }));
    }
    this._captura = null;
  }

  async _salvaUltima(c) {
    if (!(this.sessao && this._ultima)) {
      this._publica({ tipo: "erro", nivel: "aviso", codigo: "sem_sessao",
                      msg: "abra uma sessão antes de salvar" });
      return;
    }
    const [f, s11, s21, msg] = this._ultima;
    await this.sessao.gravaVarredura(msg, f, s11, s21,
      { temperatura: (c || {}).temperatura_c, rotulo: (c || {}).rotulo });
    this._publica({ tipo: "mensagem", msg: "varredura gravada na sessão" });
  }

  // ---------------------------------------------------------------- o laço
  async inicia() {
    this._parar = false;
    this._laco();
    return this;
  }

  async encerra() {
    this._parar = true;
    this._abortar.ativo = true;
    try { await this.vna.fecha(); } catch (e) { /* já caiu */ }
  }

  async _laco() {
    try {
      this.identidade = await this.vna.info();
    } catch (e) {
      this.ultimo_erro = String(e.message || e);
      this._publica({ tipo: "erro", nivel: "erro", codigo: "sem_aparelho",
                      msg: this.ultimo_erro });
      this._publica(this.estado());
      // segue vivo: o operador pode religar o cabo
    }
    await this._reconfigura();
    this._publica(this.estado());

    let tEstado = 0;
    while (!this._parar) {
      if (this._aplicaComandos()) {
        await this._reconfigura();
        this._publica(this.estado());
      }
      if (this.modo === "parado") {
        await espera(50);
        if (Date.now() / 1000 - tEstado > 1.0) {
          tEstado = Date.now() / 1000;
          this._publica(this.estado());
        }
        continue;
      }
      try {
        if (this.modo === "cw") await this._passoCw();
        else await this._passoVarredura();
        this.ultimo_erro = null;
      } catch (e) {
        if (e instanceof Abortado) {
          this._abortar.ativo = false;      // descarta a parcial; é o esperado
        } else {
          this.ultimo_erro = String(e.message || e);
          this._publica({ tipo: "erro", nivel: "erro",
                          codigo: "falha_aquisicao", msg: this.ultimo_erro });
          await this._recupera();
        }
      }
      if (Date.now() / 1000 - tEstado > 1.0) {
        tEstado = Date.now() / 1000;
        this._publica(this.estado());
      }
    }
  }

  /** Aplica a configuração no aparelho. Só entre aquisições. */
  async _reconfigura() {
    this._abortar.ativo = false;
    this.geracao += 1;
    this.portoes.reinicia();
    this.base.zera();
    this._n_cw = 0;
    if (this.modo === "parado") return;
    try {
      if (this.modo === "cw") {
        await this.vna.defineCw(this.f_cw, this.bloco_cw, 1);
      } else {
        this.pontos = Math.min(Math.round(this.pontos), PONTOS_MAX);
        await this.vna.defineVarredura(this.f_inicio, this.f_fim, this.pontos,
                                       this.vpf);
      }
    } catch (e) {
      this.ultimo_erro = String(e.message || e);
      this._publica({ tipo: "erro", nivel: "erro", codigo: "config",
                      msg: this.ultimo_erro });
      this.modo = "parado";
    }
  }

  /** Escada de recuperação: ressincroniza, e só então reabre a porta. */
  async _recupera() {
    for (let t = 0; t < 3; t++) {
      try {
        await this.vna.ressincroniza();
        await this.vna.confere();
        await this._reconfigura();
        return;
      } catch (e) {
        await espera(300 * (t + 1));
      }
    }
    try {
      await this.vna.fecha();
      await espera(500);
      await this.vna.abre();
      this.vna.abortar = this._abortar;
      await this._reconfigura();
    } catch (e) {
      this._publica({ tipo: "erro", nivel: "erro", codigo: "offline",
                      msg: "aparelho fora do ar: " + (e.message || e) });
      this.modo = "parado";
    }
  }

  // ------------------------------------------------------------- aquisição
  async _passoVarredura() {
    const t0 = Date.now();
    const r = await this.vna.varreMedia(this.medias);
    const dt = (Date.now() - t0) / 1000;
    const agora = Date.now() / 1000;
    const f = r.f;
    let s11 = r.s11, s21 = r.s21;

    // Os padrões de calibração são medidos SEM correção. Aplicar a correção
    // velha em cima deles produziria uma calibração encadeada, que é lixo.
    if (this._cal_pedido) this._medePadrao(f, s11, s21);

    const bruto11 = s11, bruto21 = s21;
    if (this.correcao) {
      const c = this.correcao(f, s11, s21, agora);
      s11 = c.s11; s21 = c.s21;
    }

    this.seq += 1;
    const n = f.length;
    this.taxa_pontos = dt > 0 ? n * this.medias / dt : NaN;
    this.taxa_varreduras = dt > 0 ? 1 / dt : NaN;

    let semDado = 0;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(s11.re[i]) || !Number.isFinite(s11.im[i])) semDado++;
    }

    this._publica({
      tipo: "varredura", seq: this.seq, geracao: this.geracao, t: agora,
      f_inicio_hz: f[0], f_passo_hz: n > 1 ? f[1] - f[0] : 0, n: n,
      medias: this.medias, cal: this._rotuloCal(), sem_dado: semDado,
      _arrays: [s11, s21],
    });

    const s = this.param === "s21" ? s21 : s11;
    const e = this.portoes.estima(f, s, this.banda);
    let modelo = null;
    let valores = null;
    if (e.valores) {
      modelo = e.valores._modelo || null;
      valores = _limpa(e.valores);
    }
    this._publica({
      tipo: "escalar", seq: this.seq, geracao: this.geracao, t: agora,
      param: this.param, valores: valores, ok: !!e.ok, motivo: e.motivo,
      banda_hz: [e.banda[0], e.banda[1]], modelo: modelo,
      estimador: "ajuste-1polo",
    });

    const linha = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      linha[i] = 20 * Math.log10(Math.hypot(s.re[i], s.im[i]));
    }
    this._publica({
      tipo: "linha_espectro", seq: this.seq, geracao: this.geracao, t: agora,
      f_inicio_hz: f[0], f_passo_hz: n > 1 ? f[1] - f[0] : 0, n: n,
      param: this.param, _arrays: [linha],
    });

    const cabecalho = { seq: this.seq, t: agora, modo: "varredura",
                        vpf: this.vpf, medias: this.medias,
                        cal: this._rotuloCal(), sem_dado: semDado };
    // No armazenamento vai o BRUTO, sempre. A correção é da leitura.
    this._ultima = [f, bruto11, bruto21, cabecalho];
    if (this.sessao && this.gravando) {
      const vid = await this.sessao.gravaVarredura(cabecalho, f, bruto11, bruto21);
      await this.sessao.gravaAjuste({
        t: agora, param: this.param, valores: e.valores, banda_hz: e.banda,
        ok: e.ok, motivo: e.motivo, estimador: "ajuste-1polo",
        varredura_id: vid,
      });
      if (this._captura) this._captura.varredura_id = vid;
    }
    if (this._captura) {
      if (this._captura.tipo === "derivado") {
        this._acumula(e.valores ? e.valores[this._captura.nome] : null,
                      e.ok, e.motivo);
      } else {
        try {
          this._acumula(ob.escalarEm(this._captura.nome, f, s,
                                     this._captura.f_alvo_hz), true);
        } catch (err) {
          this._acumula(null, false, String(err.message || err));
        }
      }
    }
  }

  async _passoCw() {
    const n = this.bloco_cw;
    const r = await this.vna.amostrasCw(n);
    const chegada = Date.now() / 1000;
    let s11 = r.s11, s21 = r.s21;
    if (this.correcao) {
      const f = new Float64Array(n).fill(this.f_cw);
      const c = this.correcao(f, s11, s21, chegada);
      s11 = c.s11; s21 = c.s21;
    }

    this.base.registra(this._n_cw + n, chegada);
    const t = this.base.instantes(this._n_cw, n);
    this._n_cw += n;
    this.seq += 1;
    this.taxa_pontos = this.base.taxa;

    const s = this.param === "s21" ? s21 : s11;
    this._publica({
      tipo: "amostras_cw", seq: this.seq, geracao: this.geracao, t: chegada,
      f_hz: this.f_cw, n: n, param: this.param, taxa_s: this.base.taxa,
      cal: this._rotuloCal(), _arrays: [t, s],
    });

    if (this._captura) {
      if (this._captura.tipo !== "traco") {
        this._acumula(null, false,
                      "grandeza derivada exige varredura, não CW");
        return;
      }
      const o = ob.REGISTRO[this._captura.nome];
      const fa = new Float64Array(n).fill(this.f_cw);
      const vals = o.calcula(fa, s);
      for (const x of vals) {
        if (!this._captura) break;
        this._acumula(Number(x), true);
      }
    }
  }

  // ----------------------------------------------------------------- estado
  _rotuloCal() {
    return this.correcao ? "aplicada" : "bruto";
  }

  estado() {
    return {
      tipo: "estado",
      aparelho: this.simulado ? "simulado"
        : (this.identidade ? "litevna" : "offline"),
      identidade: this.identidade || {},
      modo: this.modo, geracao: this.geracao, seq: this.seq,
      config: { f_inicio_hz: this.f_inicio, f_fim_hz: this.f_fim,
                n_pontos: this.pontos, vpf: this.vpf, medias: this.medias,
                f_cw_hz: this.f_cw, bloco_cw: this.bloco_cw },
      param: this.param, banda_hz: [this.banda[0], this.banda[1]],
      taxa_pontos_s: _num(this.taxa_pontos),
      taxa_varreduras_s: _num(this.taxa_varreduras),
      pontos_max: PONTOS_MAX, cal: this._rotuloCal(),
      cal_nome: this.cal_nome, cal_modo: this.cal_modo,
      cal_padroes: Object.keys(this.cal_medidas).sort(),
      sessao: this.sessao ? this.sessao.nome : null,
      gravando: !!this.gravando,
      erro: this.ultimo_erro,
    };
  }
}
