/* Gravação no navegador: IndexedDB no lugar do SQLite, mais os mesmos três
 * formatos de arquivo — gêmeo de `mwflow/armazenamento.py`.
 *
 * POR QUE INDEXEDDB, E NÃO UM ARQUIVO. Uma página estática não pode escrever
 * num diretório da máquina sem o usuário escolher o destino a cada vez. O
 * IndexedDB é o único armazenamento local do navegador que aguenta megabytes
 * de varredura e sobrevive ao fechar da aba. As tabelas são as mesmas do
 * SQLite, com os mesmos nomes, para uma exportação futura ser tradução direta.
 *
 * O QUE VAI NO DISCO. O S11 e o S21 **sem calibração**. A correção é aplicada
 * na leitura, nunca na gravação. Por isso trocar de conjunto de calibração —
 * ou de modo do colchete — depois da medida é sempre possível e nunca destrói
 * dado.
 *
 * OS TRÊS FORMATOS DE SAÍDA, e as três razões:
 *
 * - **CSV nativo do LiteVNA** é a ponte: mesmo separador, mesma vírgula
 *   decimal e as mesmas nove colunas dos dados históricos. As quatro últimas
 *   colunas são zero — no aparelho elas seriam S12 e S22, que este hardware
 *   não mede.
 * - **Touchstone** é a saída para fora, com um comentário dizendo em letras
 *   claras que S12 e S22 não foram medidos.
 * - **npz** traz as chaves `f`, `s11`, `s21`, para a análise em Python ler uma
 *   medida nova sem uma linha de mudança.
 */

"use strict";

export const CODEC = "c64x2";     // s11 e s21 em complex64, intercalados
const BANCO = "mwflow";
const VERSAO = 1;

let _db = null;

/** Abre o banco e cria as tabelas que faltarem. */
export function abreBanco() {
  if (_db) return Promise.resolve(_db);
  return new Promise((ok, erro) => {
    const req = indexedDB.open(BANCO, VERSAO);
    req.onupgradeneeded = () => {
      const db = req.result;
      const cria = (nome, indices = []) => {
        if (db.objectStoreNames.contains(nome)) return;
        const s = db.createObjectStore(nome, { keyPath: "id",
                                               autoIncrement: true });
        for (const i of indices) s.createIndex(i, i, { unique: false });
      };
      cria("sessoes");
      cria("varreduras", ["sessao_id", "t"]);
      cria("ajustes", ["sessao_id", "t"]);
      cria("curvas", ["sessao_id"]);
      cria("pontos_curva", ["curva_id"]);
      cria("ajustes_curva", ["curva_id"]);
      cria("eventos", ["sessao_id"]);
      if (!db.objectStoreNames.contains("conjuntos_cal")) {
        db.createObjectStore("conjuntos_cal", { keyPath: "nome" });
      }
    };
    req.onsuccess = () => { _db = req.result; ok(_db); };
    req.onerror = () => erro(req.error);
  });
}

function transacao(tabelas, modo) {
  return _db.transaction(tabelas, modo);
}

function promessa(req) {
  return new Promise((ok, erro) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
}

export async function insere(tabela, valor) {
  await abreBanco();
  const t = transacao([tabela], "readwrite");
  const id = await promessa(t.objectStore(tabela).add(valor));
  return id;
}

export async function poe(tabela, valor) {
  await abreBanco();
  const t = transacao([tabela], "readwrite");
  return promessa(t.objectStore(tabela).put(valor));
}

export async function pega(tabela, chave) {
  await abreBanco();
  return promessa(transacao([tabela], "readonly").objectStore(tabela).get(chave));
}

export async function apaga(tabela, chave) {
  await abreBanco();
  return promessa(transacao([tabela], "readwrite").objectStore(tabela)
    .delete(chave));
}

export async function todos(tabela, indice = null, valor = null) {
  await abreBanco();
  const s = transacao([tabela], "readonly").objectStore(tabela);
  const fonte = indice ? s.index(indice) : s;
  return promessa(valor === null ? fonte.getAll() : fonte.getAll(valor));
}

export async function chaves(tabela) {
  await abreBanco();
  return promessa(transacao([tabela], "readonly").objectStore(tabela)
    .getAllKeys());
}

// --------------------------------------------------------------- codificação
/** Dois vetores complexos num Float32Array: [re11, im11, re21, im21]. */
export function empacota(s11, s21) {
  const n = s11.re.length;
  const v = new Float32Array(4 * n);
  v.set(s11.re, 0);
  v.set(s11.im, n);
  v.set(s21.re, 2 * n);
  v.set(s21.im, 3 * n);
  return v;
}

export function desempacota(blob, n) {
  const s11 = { re: new Float64Array(n), im: new Float64Array(n) };
  const s21 = { re: new Float64Array(n), im: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    s11.re[i] = blob[i]; s11.im[i] = blob[n + i];
    s21.re[i] = blob[2 * n + i]; s21.im[i] = blob[3 * n + i];
  }
  return { s11: s11, s21: s21 };
}

// ------------------------------------------------------------------ sessão
export function agoraIso() {
  const d = new Date();
  const z = (v) => String(v).padStart(2, "0");
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate())
    + "T" + z(d.getHours()) + ":" + z(d.getMinutes()) + ":" + z(d.getSeconds());
}

export class Sessao {
  constructor(id, nome) {
    this.id = id;
    this.nome = nome;
    this.n_varreduras = 0;
  }

  static async cria(d) {
    const nome = d.nome || ("s" + agoraIso().replace(/[-:]/g, "").replace("T", "_"));
    const id = await insere("sessoes", {
      nome: nome, criada_em: agoraIso(), encerrada_em: null,
      operador: d.operador || "", descricao: d.descricao || "",
      aparelho: d.aparelho || "litevna", firmware: d.firmware || "",
      versao: "0.1.0", modo_cal: "inicial", reverif: null,
      config: d.config || {},
    });
    return new Sessao(id, nome);
  }

  async encerra(reverif, modoCal) {
    const s = await pega("sessoes", this.id);
    if (!s) return;
    s.encerrada_em = agoraIso();
    if (reverif) s.reverif = reverif;
    if (modoCal) s.modo_cal = modoCal;
    await poe("sessoes", s);
  }

  async gravaVarredura(msg, f, s11, s21, extra = {}) {
    const n = f.length;
    this.n_varreduras += 1;
    return insere("varreduras", {
      sessao_id: this.id, seq: msg.seq, t: msg.t,
      modo: msg.modo || "varredura",
      f_inicio_hz: f[0], f_passo_hz: n > 1 ? f[1] - f[0] : 0, n: n,
      vpf: msg.vpf || 1, medias: msg.medias || 1,
      cal_estado: msg.cal || "bruto", codec: CODEC,
      dados: empacota(s11, s21), sem_dado: msg.sem_dado || 0,
      temperatura_c: extra.temperatura === undefined ? null : extra.temperatura,
      rotulo: extra.rotulo || null,
    });
  }

  async gravaAjuste(msg) {
    const v = msg.valores || {};
    const b = msg.banda_hz || [null, null];
    return insere("ajustes", {
      sessao_id: this.id, varredura_id: msg.varredura_id || null,
      t: msg.t, parametro: msg.param || "s21",
      banda_lo_hz: b[0], banda_hi_hz: b[1],
      f_res: v.f_res ?? null, q: v.q ?? null, il_db: v.il_db ?? null,
      rms: v.rms ?? null, fwhm_mhz: v.fwhm_mhz ?? null,
      prominencia_db: v.prominencia_db ?? null,
      estimador: msg.estimador || "ajuste-1polo",
      ok: msg.ok ? 1 : 0, motivo: msg.motivo || null,
    });
  }

  async gravaEvento(nivel, codigo, msg) {
    return insere("eventos", { sessao_id: this.id, t: Date.now() / 1000,
                               nivel: nivel, codigo: codigo, msg: msg });
  }
}

/**
 * Despejo em texto do que a sessão produziu.
 *
 * Mesmo hábito dos scripts de pós-processamento do repositório: um arquivo com
 * tudo o que foi medido, para o relatório não depender de ninguém copiar
 * número à mão.
 */
export async function resumoSessao(sessaoId) {
  const s = await pega("sessoes", sessaoId);
  if (!s) return "";
  const varr = await todos("varreduras", "sessao_id", sessaoId);
  const ajs = await todos("ajustes", "sessao_id", sessaoId);
  const L = ["Sessão " + s.nome, "gerado em " + agoraIso(), ""];
  if (varr.length) {
    const ts = varr.map((v) => v.t);
    L.push("varreduras gravadas : " + varr.length);
    L.push("duração             : "
      + ((Math.max(...ts) - Math.min(...ts)) / 60).toFixed(1) + " min");
  }
  const bons = ajs.filter((a) => a.ok && Number.isFinite(a.f_res));
  if (bons.length) {
    const mf = bons.reduce((a, b) => a + b.f_res, 0) / bons.length;
    const mq = bons.reduce((a, b) => a + (b.q || 0), 0) / bons.length;
    L.push("ajustes aprovados   : " + bons.length);
    L.push("f_res média         : " + (mf / 1e6).toFixed(4) + " MHz");
    L.push("Q médio             : " + mq.toFixed(3));
  }
  const curvas = await todos("curvas", "sessao_id", sessaoId);
  for (const c of curvas) {
    L.push("", "curva " + c.nome + " (" + c.observavel + " em " + c.unidade_x + ")");
    const aj = (await todos("ajustes_curva", "curva_id", c.id)).pop();
    if (aj && aj.resumo) L.push("  " + aj.resumo.replace(/\n/g, "\n  "));
  }
  return L.join("\n") + "\n";
}

// ------------------------------------------------- CSV nativo do LiteVNA
/**
 * Formato exato dos arquivos históricos.
 *
 * Campos de largura fixa, alinhados à direita, separador `;`, vírgula decimal,
 * mantissa `%.9e`, fim de linha CRLF, sem cabeçalho, nove colunas. A
 * coincidência é feliz: o formato nativo já registra a ausência da chave de
 * reversão.
 */
export function escreveCsvLitevna(f, s11, s21) {
  const linhas = [];
  for (let i = 0; i < f.length; i++) {
    const campos = [s11.re[i], s11.im[i], s21.re[i], s21.im[i], 0, 0, 0, 0];
    let txt = String(Math.round(f[i])).padStart(15, " ");
    for (let v of campos) {
      if (!Number.isFinite(v)) v = 0.0;
      txt += ";" + expPython(v).padStart(19, " ");
    }
    linhas.push(txt);
  }
  return linhas.join("\r\n") + "\r\n";
}

/** `%.9e` com vírgula decimal e expoente de dois dígitos, como no Python. */
function expPython(v) {
  let s = Number(v).toExponential(9);
  s = s.replace(/e([+-])(\d)$/, "e$10$2");
  return s.replace(".", ",");
}

// ------------------------------------------------------------- Touchstone
/**
 * `.s1p` quando só há S11; `.s2p` quando há S21.
 *
 * A ordem das colunas do `.s2p` é S11 S21 S12 S22 — trocá-la é o defeito
 * clássico deste formato.
 */
export function escreveTouchstone(f, s11, s21 = null, meta = {}) {
  const dois = !!s21;
  const L = ["!MWFlow 0.1.0 (navegador)", "!Data: " + agoraIso()];
  for (const k of ["sessao", "seq", "aparelho", "firmware", "calibracao",
                   "temperatura_c", "nota"]) {
    if (meta[k] !== undefined && meta[k] !== null) {
      L.push("!" + k.charAt(0).toUpperCase() + k.slice(1) + ": " + meta[k]);
    }
  }
  if (dois) {
    L.push("!ATENCAO: hardware sem chave de reversao. S12 e S22 NAO foram");
    L.push("!         medidos. Eles saem preenchidos com zero. Nao os "
      + "interprete como medida.");
  }
  L.push("# Hz S RI R 50");
  const cab = "!" + "Frequencia".padStart(14) + " " + "Re".padStart(18) + " "
    + "Im".padStart(18)
    + (dois ? " " + ["Re(S21)", "Im(S21)", "Re(S12)", "Im(S12)", "Re(S22)",
                     "Im(S22)"].map((s) => s.padStart(18)).join(" ") : "");
  L.push(cab);
  const g = (v) => (Number.isFinite(v) ? v : 0).toExponential(9)
    .replace(/e([+-])(\d)$/, "e$10$2").padStart(18);
  for (let i = 0; i < f.length; i++) {
    let linha = String(Math.round(f[i])).padStart(15) + " " + g(s11.re[i])
      + " " + g(s11.im[i]);
    if (dois) {
      linha += " " + g(s21.re[i]) + " " + g(s21.im[i]) + " " + g(0) + " "
        + g(0) + " " + g(0) + " " + g(0);
    }
    L.push(linha);
  }
  return L.join("\n") + "\n";
}

// -------------------------------------------------------------------- npz
/* Um `.npz` é um zip de arquivos `.npy`. Aqui o zip sai SEM compressão
   (método 0, "stored"): o numpy lê os dois, e escrever deflate à mão custaria
   muito mais código do que o espaço que economizaria numa varredura. */

function crc32(bytes) {
  let c, tabela = crc32.tabela;
  if (!tabela) {
    tabela = crc32.tabela = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tabela[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ tabela[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function npy(dtype, forma, dados) {
  let cab = "{'descr': '" + dtype + "', 'fortran_order': False, 'shape': ("
    + forma.join(",") + (forma.length === 1 ? "," : "") + "), }";
  // o cabeçalho tem de terminar em \n e alinhar o total em 64 bytes
  const preambulo = 10;
  let tam = preambulo + cab.length + 1;
  const enche = (64 - (tam % 64)) % 64;
  cab += " ".repeat(enche) + "\n";
  const bytesCab = new TextEncoder().encode(cab);
  const saida = new Uint8Array(preambulo + bytesCab.length + dados.byteLength);
  saida.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  new DataView(saida.buffer).setUint16(8, bytesCab.length, true);
  saida.set(bytesCab, preambulo);
  saida.set(new Uint8Array(dados.buffer, dados.byteOffset, dados.byteLength),
            preambulo + bytesCab.length);
  return saida;
}

/** Chaves `f`, `s11`, `s21` — as mesmas que a análise em Python carrega. */
export function exportaNpz(f, s11, s21) {
  const n = f.length;
  const inter = (z) => {
    const v = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) { v[2 * i] = z.re[i]; v[2 * i + 1] = z.im[i]; }
    return v;
  };
  const membros = [
    ["f.npy", npy("<f8", [n], Float64Array.from(f))],
    ["s11.npy", npy("<c16", [n], inter(s11))],
    ["s21.npy", npy("<c16", [n], inter(s21))],
  ];
  const cod = new TextEncoder();
  const locais = [], central = [];
  let deslocamento = 0;
  for (const [nome, dados] of membros) {
    const bn = cod.encode(nome);
    const crc = crc32(dados);
    const loc = new Uint8Array(30 + bn.length);
    const dv = new DataView(loc.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);          // método 0: sem compressão
    dv.setUint32(14, crc, true);
    dv.setUint32(18, dados.length, true);
    dv.setUint32(22, dados.length, true);
    dv.setUint16(26, bn.length, true);
    loc.set(bn, 30);
    locais.push(loc, dados);

    const cen = new Uint8Array(46 + bn.length);
    const dc = new DataView(cen.buffer);
    dc.setUint32(0, 0x02014b50, true);
    dc.setUint16(4, 20, true);
    dc.setUint16(6, 20, true);
    dc.setUint16(10, 0, true);
    dc.setUint32(16, crc, true);
    dc.setUint32(20, dados.length, true);
    dc.setUint32(24, dados.length, true);
    dc.setUint16(28, bn.length, true);
    dc.setUint32(42, deslocamento, true);
    cen.set(bn, 46);
    central.push(cen);
    deslocamento += loc.length + dados.length;
  }
  let tamCentral = 0;
  for (const c of central) tamCentral += c.length;
  const fim = new Uint8Array(22);
  const df = new DataView(fim.buffer);
  df.setUint32(0, 0x06054b50, true);
  df.setUint16(8, membros.length, true);
  df.setUint16(10, membros.length, true);
  df.setUint32(12, tamCentral, true);
  df.setUint32(16, deslocamento, true);
  return new Blob(locais.concat(central, [fim]),
                  { type: "application/octet-stream" });
}

// ------------------------------------------------------------- descarga
/** Manda o navegador salvar um conteúdo como arquivo. */
export function baixa(nome, conteudo, tipo = "text/plain;charset=utf-8") {
  const b = conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------- conjuntos de calibração
export async function salvaCal(nome, termos, kit, meta = {}) {
  const guarda = {};
  for (const k of ["f", "e00", "e11", "e10e01", "e30", "e10e32", "cond"]) {
    if (!termos[k]) continue;
    guarda[k] = termos[k].re
      ? { re: Float64Array.from(termos[k].re), im: Float64Array.from(termos[k].im) }
      : Float64Array.from(termos[k]);
  }
  const d = Object.assign({
    nome: nome, criado_em: agoraIso(), kit: kit,
    f_inicio_hz: termos.f[0], f_fim_hz: termos.f[termos.f.length - 1],
    n: termos.f.length,
    cond_max: termos.cond ? Math.max(...termos.cond) : 1,
    tipo: termos.e10e32 ? "resposta_melhorada" : "1porta",
    termos: guarda,
  }, meta);
  await poe("conjuntos_cal", d);
  return d;
}

export async function carregaCal(nome) {
  const d = await pega("conjuntos_cal", nome);
  if (!d) throw new Error("conjunto de calibração desconhecido: " + nome);
  const termos = {};
  for (const [k, v] of Object.entries(d.termos)) {
    termos[k] = v.re ? { re: v.re, im: v.im } : v;
  }
  const meta = Object.assign({}, d);
  delete meta.termos;
  return { termos: termos, meta: meta };
}

export async function listaCals() {
  await abreBanco();
  return (await chaves("conjuntos_cal")).sort();
}
