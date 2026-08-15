/* Modo local: o MWFlow inteiro dentro do navegador, sem servidor.
 *
 * ESTE ARQUIVO É A COSTURA. Ele põe no lugar do WebSocket e do `fetch` duas
 * peças que falam exatamente a mesma língua:
 *
 * - `MW.ws` — mesmo `manda`, `em` e `assina`, mas as mensagens vêm de uma
 *   chamada de função, e não de um socket. As cinco telas não sabem a
 *   diferença e não precisaram de nenhuma mudança de lógica.
 * - `MW.api` — mesmas rotas `/api/...`, respondidas aqui dentro contra o
 *   IndexedDB, em vez de irem para o Starlette.
 *
 * Manter o contrato idêntico é o que permite as duas versões dividirem as
 * telas. Se um dia uma rota mudar de forma, ela muda nos dois lados no mesmo
 * commit, senão a versão do navegador quebra em silêncio.
 *
 * DE ONDE VEM O APARELHO. Nada começa sozinho. O usuário escolhe, num cartão
 * na frente da página, entre ligar o LiteVNA64 pela porta USB ou abrir a
 * bancada simulada. Duas razões: o `requestPort()` do navegador só funciona
 * dentro de um clique, e um programa de medida não pode começar a produzir
 * número antes de alguém dizer de onde ele vem.
 */

"use strict";

import * as az from "./armazenamento.js";
import * as cv from "./curva.js";
import * as kitCal from "./kit_cal.js";
import * as ob from "./observaveis.js";
import * as solt from "./solt.js";
import { LiteVNA } from "./litevna.js";
import { Motor } from "./motor.js";
import { PortaSimulada } from "./porta_simulada.js";
import { PortaWebSerial, temWebSerial } from "./porta_webserial.js";

const MW = window.MW;

/* Servida pelo MWFlow em Python, esta página já tem um servidor por trás e um
   WebSocket ligado nele. Neste caso o núcleo local sai de cena inteiro: dois
   motores disputando a mesma porta serial seria a pior falha possível. */
const MODO_SERVIDOR = window.MWFLOW_MODO === "servidor";

const TOPICOS_PADRAO = ["estado", "erro", "escalar", "varredura", "ponto",
                        "captura", "mensagem", "cal", "curva"];

let motor = null;
let curvaAtual = null;
const ouvintes = {};
let assinatura = null;

// ------------------------------------------------------------- barramento
function despacha(msg) {
  const l = ouvintes[msg.tipo];
  if (l) l.forEach((f) => { try { f(msg); } catch (e) { console.error(e); } });
}

/**
 * Prepara a mensagem para a tela.
 *
 * O servidor manda os vetores num quadro binário e a tela os lê em
 * `msg.vetores`. Aqui não há quadro nenhum, mas o campo continua sendo
 * `vetores`, com os mesmos tipos, para as telas não mudarem. Em modo CW o
 * cabeçalho ainda leva `t0` e a carga leva só a diferença: o instante Unix
 * absoluto não sobrevive a um float32, e uma tela que dependesse disso
 * quebraria ao trocar de modo.
 */
function comVetores(msg) {
  if (!msg._arrays) return msg;
  const m = Object.assign({}, msg);
  delete m._arrays;
  if (msg.tipo === "amostras_cw") {
    const [t, s] = msg._arrays;
    const rel = new Float64Array(t.length);
    for (let i = 0; i < t.length; i++) rel[i] = t[i] - t[0];
    m.t0 = t[0];
    m.vetores = [rel, s];
  } else {
    m.vetores = msg._arrays;
  }
  return m;
}

function ligaBarramento() {
  MW.ws = {
    conecta: function () {
      MW.mensagem("núcleo local pronto");
      despacha({ tipo: "_ligado" });
    },
    em: function (tipo, fn) {
      (ouvintes[tipo] = ouvintes[tipo] || []).push(fn);
    },
    manda: function (obj) {
      if (!motor) return false;
      if (obj.t === "assinar") {
        if (assinatura) assinatura.topicos = new Set(obj.topicos || TOPICOS_PADRAO);
        return true;
      }
      if (obj.t === "quedas") {
        // Sem fila entre produtor e consumidor não há quadro descartado. O
        // campo continua existindo para a tela não precisar de um caso à parte.
        despacha(Object.assign(motor.estado(), { quedas: {}, tipo: "estado" }));
        return true;
      }
      if (obj.t === "capturar" && !obj.curva_id) obj.curva_id = curvaAtual;
      motor.comanda(obj);
      return true;
    },
    assina: function (topicos) {
      if (assinatura) assinatura.topicos = new Set(topicos);
    },
  };
}

// ------------------------------------------------------------------ rotas
/* Estado antes de o usuário escolher o aparelho. Ele existe com todos os
   campos porque a tela lê `banda_hz[0]` sem perguntar; devolver um objeto
   pela metade quebraria o painel antes de qualquer medida. */
function estadoVazio() {
  return {
    tipo: "estado", aparelho: "offline", identidade: {}, modo: "parado",
    geracao: 0, seq: 0,
    config: { f_inicio_hz: 50e6, f_fim_hz: 3e9, n_pontos: 401, vpf: 1,
              medias: 1, f_cw_hz: 1.5e9, bloco_cw: 64 },
    param: "s21", banda_hz: [1.30e9, 2.00e9],
    taxa_pontos_s: null, taxa_varreduras_s: null, pontos_max: 1024,
    cal: "bruto", cal_nome: null, cal_modo: "inicial", cal_padroes: [],
    sessao: null, gravando: false, erro: null,
  };
}

/**
 * Nomes e unidades de uma curva, com as curvas antigas em pé — gêmeo do
 * `descreve_curva` do servidor.
 *
 * O X e a covariável passaram a ser grandezas que o operador nomeia. Antes
 * disso o X era sempre um analito e a covariável era sempre a temperatura em
 * grau Celsius; as curvas gravadas naquele tempo não têm os campos novos, e é
 * aqui que elas ganham o sentido que tinham.
 */
function descreveCurva(c) {
  if (!c) return null;
  const d = Object.assign({}, c);
  d.grandeza_x = d.grandeza_x || d.analito || "X";
  d.unidade_x = d.unidade_x || "";
  if (d.covariavel) {
    d.unidade_cov = d.unidade_cov || "";
  } else {
    d.covariavel = "temperatura";
    d.unidade_cov = "°C";
  }
  d.cov_exigida = d.cov_exigida === undefined || d.cov_exigida ? 1 : 0;
  return d;
}

async function pontosDaCurva(cid) {
  const curva = await az.pega("curvas", cid);
  const pontos = (await az.todos("pontos_curva", "curva_id", cid))
    .sort((a, b) => a.t - b.t);
  for (const p of pontos) {
    if (p.cov === undefined || p.cov === null) p.cov = p.temperatura_c ?? null;
  }
  return { curva: descreveCurva(curva), pontos: pontos };
}

function unidadeY(curva) {
  if (!curva) return "";
  const obsId = curva.observavel || "";
  const i = obsId.indexOf(":");
  const tipo = obsId.slice(0, i), nome = obsId.slice(i + 1);
  if (tipo === "derivado") return ob.UNIDADE_ESCALAR[nome] || "";
  const o = ob.REGISTRO[nome];
  return o ? o.unidade : "";
}

async function ajustaCurvaId(cid, d) {
  const dados = await pontosDaCurva(cid);
  const c = dados.curva || { unidade_x: "", covariavel: "", unidade_cov: "" };
  const pts = dados.pontos.filter((p) => p.incluido);
  if (pts.length < 3) return { erro: "a curva tem menos de 3 pontos incluídos" };
  const uy = unidadeY(dados.curva);

  let sigma = d.sigma_y;
  let origem = d.sigma_origem || "medida";
  if (origem === "medida") {
    const desvios = pts.filter((p) => p.y_desvio && p.n_med > 1)
      .map((p) => p.y_desvio);
    if (desvios.length) {
      // desvio combinado dentro dos níveis
      sigma = Math.sqrt(desvios.reduce((a, b) => a + b * b, 0) / desvios.length);
    } else if (sigma === null || sigma === undefined) {
      origem = "residuo";
    }
  }
  const tipo = cv.canon(d.tipo || "linear");
  const a = cv.ajustaCurva(pts.map((p) => p.x), pts.map((p) => p.y), {
    tipo: tipo,
    faixa: [d.faixa_lo ?? null, d.faixa_hi ?? null],
    cov_valores: tipo === "covariavel" ? pts.map((p) => p.cov) : null,
    sigma_y: sigma, sigma_origem: origem,
    unidade_x: c.unidade_x, unidade_y: uy,
    nome_cov: c.covariavel, unidade_cov: c.unidade_cov,
  });
  if (a.erro) return a;
  a.resumo = cv.textoResumo(a, c.unidade_x, uy);
  // alinhados com os resíduos: uma faixa deixa pontos de fora
  a.ordem = a.indices.map((i) => pts[i].ordem_sorteada || i + 1);
  // `cov_pontos`, e não `cov`: `cov` já é a matriz de covariância do ajuste
  a.cov_pontos = a.indices.map((i) => pts[i].cov);
  a.unidade_y = uy;
  await az.insere("ajustes_curva", {
    curva_id: cid, criado_em: a.criado_em, tipo: a.tipo, grau: a.grau,
    faixa_lo: a.faixa[0], faixa_hi: a.faixa[1], n: a.n,
    coefs: a.coefs, cov: a.cov, r2: a.r2, r2_aj: a.r2_aj, s_yx: a.s_yx,
    sensibilidade: a.sensibilidade, unidade_sens: a.unidade_sens,
    sigma_y: a.sigma_y, sigma_origem: a.sigma_origem, lod: a.lod, loq: a.loq,
    resumo: a.resumo,
  });
  return a;
}

/** `%.9g` com vírgula decimal — o mesmo `_v` do servidor, para o CSV bater. */
function _v(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return "";
  return cv._g(Number(x), 9).replace(".", ",");
}

/* A coluna `cov` leva a covariável da curva, seja ela qual for. O nome da
   coluna é fixo de propósito: um cabeçalho que mudasse com a curva quebraria
   todo script que lesse a exportação. */
async function csvCurva(cid) {
  const d = await pontosDaCurva(cid);
  const L = ["x;y;y_desvio;n_med;cov;replica;ordem_sorteada;"
    + "x_ref;t_iso;incluido;nota"];
  for (const p of d.pontos) {
    const dt = new Date(p.t * 1000);
    const z = (v) => String(v).padStart(2, "0");
    const iso = dt.getFullYear() + "-" + z(dt.getMonth() + 1) + "-"
      + z(dt.getDate()) + "T" + z(dt.getHours()) + ":" + z(dt.getMinutes())
      + ":" + z(dt.getSeconds());
    L.push([_v(p.x), _v(p.y), _v(p.y_desvio), String(p.n_med),
            _v(p.cov), p.replica || "",
            String(p.ordem_sorteada || ""), _v(p.x_ref), iso,
            String(p.incluido), (p.nota || "").replace(/;/g, ",")].join(";"));
  }
  return L.join("\n") + "\n";
}

async function resolveCal(d) {
  const m = motor.cal_medidas;
  const faltam = ["aberto", "curto", "carga"].filter((k) => !m[k]);
  if (faltam.length) return { erro: "faltam padrões: " + faltam.join(", ") };
  const kit = kitCal.carregaKit(d.kit || "sma_generico");
  const f = m.aberto.f;
  for (const k of ["curto", "carga"]) {
    if (m[k].f.length !== f.length || Math.abs(m[k].f[0] - f[0]) > 1) {
      return { erro: "os padrões foram medidos em grades diferentes; refaça a "
        + "calibração" };
    }
  }
  const medidos = {};
  for (const k of ["aberto", "curto", "carga"]) medidos[k] = m[k].s11;
  const t = solt.resolveUmaPorta(f, medidos, kit);
  const cond = Math.max(...t.cond);
  let aviso = null;
  if (cond > solt.COND_LIMITE) {
    aviso = "condicionamento ruim (" + cond.toExponential(1) + "). Os três "
      + "padrões ficaram perto demais na carta de Smith — quase sempre é "
      + "padrão trocado, mal rosqueado ou danificado.";
  }
  if (m.thru) {
    const iso = m.isolamento ? m.isolamento.s21 : null;
    Object.assign(t, solt.resolveTransmissao(f, m.thru.s21, iso, kit));
  }
  const nome = d.nome || ("cal_" + az.agoraIso().replace(/[-:]/g, "")
    .replace("T", "_"));
  const meta = await az.salvaCal(nome, t, kit, {
    aparelho: motor.simulado ? "simulado" : "litevna",
    firmware: (motor.identidade || {}).firmware || "",
    isolamento: m.isolamento ? 1 : 0,
    medias: d.n_medias || null,
    temperatura_c: d.temperatura_c ?? null, nota: d.nota || null,
  });
  return { nome: nome, cond_max: cond, tipo: meta.tipo, aviso: aviso,
           n: f.length, f_inicio_hz: f[0], f_fim_hz: f[f.length - 1] };
}

async function reverificaCal() {
  const m = motor.cal_medidas;
  if (!motor.cal_nome) {
    return { erro: "não há calibração aplicada para reverificar" };
  }
  const faltam = ["aberto", "curto", "carga"].filter((k) => !m[k]);
  if (faltam.length) {
    return { erro: "meça os padrões de novo: faltam " + faltam.join(", ") };
  }
  const a = await az.carregaCal(motor.cal_nome);
  const f = m.aberto.f;
  let t;
  try {
    t = solt.interpola(a.termos, f);
  } catch (e) {
    return { erro: e.message };
  }
  const nomeKit = (a.meta.kit && a.meta.kit.nome) || "sma_generico";
  const medidos = {};
  for (const k of ["aberto", "curto", "carga"]) medidos[k] = m[k].s11;
  const r = solt.reverifica(f, t, medidos, kitCal.carregaKit(nomeKit));
  r.cal = motor.cal_nome;
  if (motor.sessao) {
    await motor.sessao.gravaEvento("info", "reverificacao", JSON.stringify(r));
  }
  return r;
}

async function exporta(d) {
  if (!motor._ultima) return { erro: "não há varredura para exportar" };
  const [f, s11, s21, cab] = motor._ultima;
  const base = d.nome || ("varredura_" + az.agoraIso().slice(11).replace(/:/g, ""));
  const meta = {
    sessao: motor.sessao ? motor.sessao.nome : "avulsa", seq: cab.seq,
    aparelho: motor.simulado ? "simulado" : "LiteVNA64",
    firmware: (motor.identidade || {}).firmware,
    calibracao: motor.cal_nome || "nenhuma (dado bruto)",
    temperatura_c: d.temperatura_c ?? null, nota: d.nota || null,
  };
  az.baixa(base + ".s2p", az.escreveTouchstone(f, s11, s21, meta));
  az.baixa(base + ".csv", az.escreveCsvLitevna(f, s11, s21));
  az.baixa(base + ".npz", az.exportaNpz(f, s11, s21));
  return { arquivos: [base + ".s2p", base + ".csv", base + ".npz"] };
}

async function roteia(caminho, opcoes) {
  const corpo = opcoes && opcoes.body ? JSON.parse(opcoes.body) : {};
  const p = caminho.split("?")[0];

  if (p === "/api/observaveis") {
    return { observaveis: ob.catalogo(),
             unidade_escalar: ob.UNIDADE_ESCALAR,
             rotulo_escalar: ob.ROTULO_ESCALAR };
  }
  if (p === "/api/estado") return motor ? motor.estado() : estadoVazio();
  if (p === "/api/kits") {
    return { kits: kitCal.listaKits(), cals: await az.listaCals() };
  }
  if (p === "/api/sessao" || p === "/api/sessao/encerrar") {
    if (p.endsWith("encerrar")) {
      const s = motor.sessao;
      if (!s) return { erro: "não há sessão aberta" };
      await s.encerra(corpo.reverificacao, corpo.modo_cal);
      const texto = await az.resumoSessao(s.id);
      az.baixa("numeros_" + s.nome + ".txt", texto);
      motor.sessao = null;
      motor.gravando = false;
      return { nome: s.nome, encerrada: true };
    }
    const s = await az.Sessao.cria({
      nome: corpo.nome, operador: corpo.operador, descricao: corpo.descricao,
      aparelho: motor.simulado ? "simulado" : "litevna",
      firmware: (motor.identidade || {}).firmware || "",
      config: motor.estado().config,
    });
    motor.sessao = s;
    motor.gravando = corpo.gravar !== false;
    return { id: s.id, nome: s.nome, pasta: "(IndexedDB)" };
  }
  if (p === "/api/curvas") {
    const curvas = (await az.todos("curvas")).sort((a, b) => b.id - a.id)
      .slice(0, 50).map(descreveCurva);
    for (const c of curvas) {
      c.n_pontos = (await az.todos("pontos_curva", "curva_id", c.id)).length;
    }
    return { curvas: curvas, atual: curvaAtual };
  }
  if (p === "/api/curva" && opcoes && opcoes.method === "POST") {
    const e = motor.estado();
    const gx = corpo.grandeza_x || corpo.analito || "";
    const id = await az.insere("curvas", {
      nome: corpo.nome || ("curva_" + az.agoraIso().replace(/[-:]/g, "")
        .replace("T", "_")),
      criada_em: az.agoraIso(),
      sessao_id: motor.sessao ? motor.sessao.id : null,
      analito: gx, unidade_x: corpo.unidade_x || "",
      grandeza_x: gx, covariavel: corpo.covariavel || "",
      unidade_cov: corpo.unidade_cov || "",
      cov_exigida: corpo.cov_exigida === false ? 0 : 1,
      observavel: corpo.observavel || "derivado:f_res", param: e.param,
      banda_lo_hz: e.banda_hz[0], banda_hi_hz: e.banda_hz[1],
      f_alvo_hz: corpo.f_alvo_hz ?? null, semente: corpo.semente ?? null,
      descricao: corpo.descricao || "",
    });
    curvaAtual = id;
    return { id: id };
  }
  let m = p.match(/^\/api\/curva\/(\d+)$/);
  if (m) return pontosDaCurva(Number(m[1]));
  m = p.match(/^\/api\/curva\/(\d+)\/definicao$/);
  if (m) {
    /* Renomeia o X e a covariável de uma curva já aberta. Só rótulo muda:
       nenhum número medido depende do nome da grandeza. */
    const c = await az.pega("curvas", Number(m[1]));
    if (!c) return { erro: "curva não encontrada" };
    const gx = (corpo.grandeza_x || "").trim();
    c.grandeza_x = gx;
    c.analito = gx;
    c.unidade_x = (corpo.unidade_x || "").trim();
    c.covariavel = (corpo.covariavel || "").trim();
    c.unidade_cov = (corpo.unidade_cov || "").trim();
    c.cov_exigida = corpo.cov_exigida === false ? 0 : 1;
    await az.poe("curvas", c);
    return { ok: true };
  }
  m = p.match(/^\/api\/curva\/(\d+)\/ajustar$/);
  if (m) return ajustaCurvaId(Number(m[1]), corpo);
  m = p.match(/^\/api\/curva\/(\d+)\/inversa$/);
  if (m) {
    const a = await ajustaCurvaId(Number(m[1]), corpo);
    if (a.erro) return a;
    return cv.inversa(a, Number(corpo.y), {
      m: Number(corpo.m || 1),
      cov_valor: corpo.cov ?? corpo.temperatura_c,
    });
  }
  m = p.match(/^\/api\/curva\/(\d+)\/csv$/);
  if (m) return { _texto: await csvCurva(Number(m[1])) };
  m = p.match(/^\/api\/curva\/(\d+)\/r2$/);
  if (m) {
    const d = await pontosDaCurva(Number(m[1]));
    const pts = d.pontos.filter((x) => x.incluido && x.varredura_id);
    if (pts.length < 3) {
      return { erro: "a varredura de R² precisa de 3 pontos ou mais com "
        + "varredura gravada. Ligue a gravação antes de capturar." };
    }
    const linhas = [], xs = [];
    let f = null;
    for (const pt of pts) {
      const v = await az.pega("varreduras", pt.varredura_id);
      if (!v) continue;
      const z = az.desempacota(v.dados, v.n);
      const s = (d.curva.param || "s21") === "s21" ? z.s21 : z.s11;
      const linha = new Float64Array(v.n);
      for (let i = 0; i < v.n; i++) {
        linha[i] = 20 * Math.log10(Math.hypot(s.re[i], s.im[i]));
      }
      linhas.push(linha);
      xs.push(pt.x);
      f = new Float64Array(v.n);
      for (let i = 0; i < v.n; i++) f[i] = v.f_inicio_hz + v.f_passo_hz * i;
    }
    if (linhas.length < 3) return { erro: "varreduras insuficientes" };
    return cv.varreduraR2(f, linhas, xs);
  }
  if (p === "/api/ponto") {
    if (corpo.apagar) {
      await az.apaga("pontos_curva", corpo.id);
    } else {
      const pt = await az.pega("pontos_curva", corpo.id);
      if (pt) {
        pt.incluido = corpo.incluido ? 1 : 0;
        if (corpo.nota !== undefined && corpo.nota !== null) pt.nota = corpo.nota;
        await az.poe("pontos_curva", pt);
      }
    }
    return { ok: true };
  }
  if (p === "/api/planejar") {
    return cv.planejaSerie(Number(corpo.x_min), Number(corpo.x_max),
                           Number(corpo.passo), {
      replicas: Number(corpo.replicas || 1), referencia: corpo.referencia,
      intercalar_a_cada: Number(corpo.intercalar || 3), semente: corpo.semente,
    });
  }
  if (p === "/api/cal/resolver") return resolveCal(corpo);
  if (p === "/api/cal/aplicar") {
    return motor.aplicaCorrecao(corpo.nome || null, corpo.nome_fim || null,
                                corpo.modo || "inicial");
  }
  if (p === "/api/cal/reverificar") return reverificaCal();
  if (p === "/api/exportar") return exporta(corpo);
  return { erro: "rota desconhecida no modo local: " + p };
}

function ligaApi() {
  MW.api = function (caminho, opcoes) {
    return roteia(caminho, opcoes).then((d) => ({
      ok: true,
      json: () => Promise.resolve(d && d._texto !== undefined ? {} : d),
      text: () => Promise.resolve(d && d._texto !== undefined
        ? d._texto : JSON.stringify(d)),
    })).catch((e) => {
      console.error("rota local falhou:", caminho, e);
      const d = { erro: String(e.message || e) };
      return { ok: false, json: () => Promise.resolve(d),
               text: () => Promise.resolve(JSON.stringify(d)) };
    });
  };
}

// -------------------------------------------------------------- gravação
/** O ponto capturado vira linha na tabela, como o servidor faz no envio. */
async function gravaPonto(msg) {
  const cid = msg.curva_id || curvaAtual;
  if (!cid) return;
  await az.insere("pontos_curva", {
    curva_id: cid, varredura_id: msg.varredura_id || null,
    x: msg.x, y: msg.y, y_desvio: msg.y_desvio, n_med: msg.n_med || 1,
    // `cov` é o valor da covariável da curva, qualquer que seja ela.
    // `temperatura_c` é o nome antigo do mesmo campo.
    brutos: msg.brutos || [], cov: msg.cov ?? msg.temperatura_c ?? null,
    temperatura_origem: "manual", replica: msg.replica || null,
    ordem_sorteada: msg.ordem ?? null, x_ref: msg.x_ref ?? null,
    t: msg.t, incluido: 1, nota: msg.nota || null,
  });
}

// ------------------------------------------------------------- aparelho
async function comeca(vna) {
  motor = new Motor(vna);
  assinatura = motor.assina(TOPICOS_PADRAO, (msg) => {
    if (msg.tipo === "ponto") gravaPonto(msg);
    despacha(comVetores(msg));
  });
  await az.abreBanco();
  await motor.inicia();
  motor.comanda({ t: "modo", modo: "varredura" });
  MW.q("#cartao-aparelho").classList.add("oculto");
  despacha({ tipo: "_ligado" });
}

function cartao() {
  const div = document.createElement("div");
  div.id = "cartao-aparelho";
  div.innerHTML =
    '<div class="cartao">'
    + "<h2>De onde vem a medida?</h2>"
    + "<p>O MWFlow roda inteiro neste navegador. Nada é enviado para "
    + "servidor nenhum.</p>"
    + '<button id="liga-usb" class="primario">Ligar o LiteVNA64 pela porta USB</button>'
    + '<p class="nota" id="nota-usb"></p>'
    + '<button id="liga-sim">Abrir a bancada simulada</button>'
    + '<p class="nota">A bancada simulada devolve os mesmos bytes que o '
    + "aparelho devolveria, com ruído e caixa de erro. Todo dado que sair "
    + "dela leva o rótulo <strong>simulado</strong> até o arquivo.</p>"
    + "</div>";
  document.body.appendChild(div);

  const nota = div.querySelector("#nota-usb");
  const botao = div.querySelector("#liga-usb");
  if (!temWebSerial()) {
    botao.disabled = true;
    nota.innerHTML = "<strong>Este navegador não tem WebSerial.</strong> "
      + "A porta USB só abre no Chrome, no Edge ou no Opera de desktop. "
      + "No Firefox e no Safari só a bancada simulada funciona.";
  } else if (location.protocol !== "https:" && location.hostname !== "localhost"
             && location.hostname !== "127.0.0.1") {
    botao.disabled = true;
    nota.innerHTML = "<strong>Esta página não está em HTTPS.</strong> "
      + "O navegador só libera a porta serial em HTTPS ou em localhost.";
  } else {
    nota.textContent = "O navegador vai pedir para você escolher a porta. "
      + "No Linux, o seu usuário precisa estar no grupo dialout.";
  }

  botao.addEventListener("click", async function () {
    try {
      let porta = null;
      const antigas = await PortaWebSerial.jaAutorizadas();
      if (antigas.length === 1) porta = antigas[0];
      if (!porta) {
        try {
          porta = await PortaWebSerial.pede(true);
        } catch (e) {
          // Nenhuma porta bateu com o filtro do LiteVNA desta bancada. Outra
          // unidade pode ter outro identificador USB, então vale abrir de novo
          // sem filtro em vez de dizer que não há aparelho.
          porta = await PortaWebSerial.pede(false);
        }
      }
      await comeca(new LiteVNA(porta));
    } catch (e) {
      nota.innerHTML = "<strong>Não abriu:</strong> " + (e.message || e);
    }
  });

  div.querySelector("#liga-sim").addEventListener("click", function () {
    comeca(new LiteVNA(new PortaSimulada({ dut: "ressoador" })));
  });
}

// ------------------------------------------------------------------ carga
if (!MODO_SERVIDOR) {
  ligaBarramento();
  ligaApi();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", cartao);
  } else {
    cartao();
  }
}
