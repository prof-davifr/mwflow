/* Paridade entre o núcleo em JavaScript e o MWFlow em Python.
 *
 *     python3 -m testes.vetores      # gera testes/_vetores.json
 *     node testes/paridade.mjs
 *
 * O Python é a verdade: foi ele que produziu os números medidos nesta bancada.
 * Quando uma linha falha, quem está errado é o JavaScript.
 *
 * As tolerâncias não são redondas por acaso. Onde os dois lados fazem a MESMA
 * conta, a exigência é de precisão de máquina (1e-9 relativo é folga de três
 * ordens). Onde os algoritmos diferem por natureza — o otimizador do ajuste e
 * o gerador do Monte Carlo — a exigência é física, e o motivo está escrito ao
 * lado do caso.
 */

"use strict";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const NUCLEO = path.join(AQUI, "..", "mwflow", "web", "js", "nucleo");

/* O kit_cal guarda kits do usuário no localStorage, que não existe no node.
   Um par de funções vazias basta: os kits embutidos não passam por ele. */
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const num = await import(path.join(NUCLEO, "num.js"));
const proto = await import(path.join(NUCLEO, "protocolo.js"));
const ajusteMod = await import(path.join(NUCLEO, "ajuste.js"));
const kitCal = await import(path.join(NUCLEO, "kit_cal.js"));
const solt = await import(path.join(NUCLEO, "solt.js"));
const cv = await import(path.join(NUCLEO, "curva.js"));
const az = await import(path.join(NUCLEO, "armazenamento.js"));

const ARQ = path.join(AQUI, "_vetores.json");
if (!fs.existsSync(ARQ)) {
  console.error("faltam os vetores de referência. Rode antes:\n"
    + "    python3 -m testes.vetores");
  process.exit(2);
}
const R = JSON.parse(fs.readFileSync(ARQ, "utf8"));

let falhas = 0, casos = 0;
const cx = (o) => ({ re: Float64Array.from(o.re), im: Float64Array.from(o.im) });

function relata(nome, ok, detalhe) {
  casos++;
  if (!ok) falhas++;
  console.log((ok ? "  ok   " : "  MAU  ") + nome.padEnd(34) + " " + detalhe);
}

/** Compara números soltos, vetores ou matrizes, no pior erro relativo. */
function cmp(nome, a, b, tol = 1e-9) {
  const A = [a].flat(4), B = [b].flat(4);
  let pior = 0;
  for (let i = 0; i < B.length; i++) {
    if (B[i] === null || !Number.isFinite(B[i])) continue;
    const d = Math.abs(A[i] - B[i]) / Math.max(1e-12, Math.abs(B[i]));
    if (d > pior) pior = d;
  }
  relata(nome, pior <= tol, "pior erro relativo " + pior.toExponential(2));
}

/** Compara vetores complexos pelo módulo da diferença. */
function cmpC(nome, a, b, tol = 1e-9) {
  let pior = 0;
  for (let i = 0; i < b.re.length; i++) {
    const d = Math.hypot(a.re[i] - b.re[i], a.im[i] - b.im[i]);
    const ref = Math.max(1e-12, Math.hypot(b.re[i], b.im[i]));
    if (!Number.isFinite(b.re[i])) {
      if (Number.isFinite(a.re[i])) pior = Infinity;   // NaN tem de virar NaN
      continue;
    }
    if (d / ref > pior) pior = d / ref;
  }
  relata(nome, pior <= tol, "pior erro relativo " + pior.toExponential(2));
}

// ------------------------------------------------------------------- num
console.log("\nnúcleo numérico (numpy e scipy)");
{
  const d = R.num;
  const x = Float64Array.from(d.x), y = Float64Array.from(d.y);
  const p1 = num.ajustaPolinomio(x, y, 1), p2 = num.ajustaPolinomio(x, y, 2);
  cmp("polyfit grau 1", p1.coefs, d.polyfit1);
  cmp("polyfit grau 1, covariância", p1.cov, d.cov1);
  cmp("polyfit grau 2", p2.coefs, d.polyfit2, 1e-8);
  cmp("polyfit grau 2, covariância", p2.cov, d.cov2, 1e-8);
  cmp("t de Student, quantil", [num.tPpf(0.975, 5), num.tPpf(0.975, 40),
                                num.tPpf(0.975, 3)], d.t_ppf, 1e-10);
  const f = Float64Array.from(d.f), fase = Float64Array.from(d.fase);
  const u = num.desdobra(fase);
  cmp("unwrap da fase", Array.from(u), d.unwrap);
  cmp("gradiente", Array.from(num.gradiente(u, f)), d.gradiente);
  cmp("número de condição 3x3", [num.condicao3C(d.matriz)], [d.cond]);
  cmp("raízes reais de cúbica",
      num.raizesReais([2, -3, -3, 2]).sort((a, b) => a - b), d.raizes);
}

// ------------------------------------------------------------- protocolo
console.log("\nprotocolo binário e FIFO");
{
  const d = R.fifo;
  const r = proto.analisaFifo(Uint8Array.from(d.bytes));
  cmp("índices de frequência", Array.from(r.idx), d.idx);
  cmpC("S11 = rev0/fwd0", r.s11, cx(d.s11));
  cmpC("S21 = rev1/fwd0", r.s21, cx(d.s21));
  const semDado = !Number.isFinite(r.s11.re[2]) && !Number.isFinite(r.s21.re[2]);
  relata("fwd0 nulo vira NaN", semDado, semDado ? "sem estouro" : "estourou");
  const q = R.protocolo;
  cmp("passo inteiro da varredura",
      [proto.passoDe(1.30e9, 2.00e9, 401), proto.passoDe(50e6, 3e9, 1024),
       proto.passoDe(1e9, 1e9, 1)], q.passo);
  const bytes = Array.from(proto.cmdVarredura(1.30e9, 1750000, 401, 2));
  relata("bytes do comando de varredura",
         JSON.stringify(bytes) === JSON.stringify(q.cmd_varredura),
         bytes.length + " bytes");
  relata("teto de pontos", proto.PONTOS_MAX === q.pontos_max,
         String(proto.PONTOS_MAX));
}

// ---------------------------------------------------------------- ajuste
console.log("\najuste de 1 polo (f_res e Q)");
console.log("  o Python usa o MINPACK e o JavaScript um Levenberg-Marquardt");
console.log("  próprio: exige-se o mesmo MÍNIMO, não o mesmo caminho até ele.");
for (const [rot, d] of Object.entries(R.ajuste)) {
  const f = Float64Array.from(d.f);
  const s = cx(d.s21);
  const r = ajusteMod.ajusta(f, s, [1.30e9, 2.00e9]);
  const custo = r.rms * r.rms * 2 * f.length;
  // O custo define o mínimo. Se ele bate, os dois estão no mesmo fundo de vale.
  const dCusto = Math.abs(custo - d.custo) / d.custo;
  relata("custo do mínimo (" + rot + ")", dCusto <= 1e-9,
         "diferença relativa " + dCusto.toExponential(2)
         + (custo <= d.custo ? " (o JS achou igual ou melhor)" : ""));
  // 1 kHz é mil vezes menor que o menor deslocamento que este sensor mede
  // (2,7 MHz) e trezentas vezes menor que o ruído do argmax (0,3 MHz).
  const dF = Math.abs(r.f0 - d.res.f0);
  relata("f_res (" + rot + ")", dF <= 1e3,
         "diferença de " + dF.toFixed(1) + " Hz, limite 1 kHz");
  cmp("Q (" + rot + ")", [r.Q], [d.res.Q], 1e-5);
  cmp("IL (" + rot + ")", [r.ilDb], [d.res.il_db], 1e-4);
}

// ------------------------------------------------------------------ SOLT
console.log("\ncalibração SOLT e modelos de padrão");
{
  const d = R.solt;
  const f = Float64Array.from(d.f);
  const pad = kitCal.padroes(f, d.kit);
  for (const k of ["aberto", "curto", "carga"]) {
    cmpC("padrão " + k + " (kit SMA)", pad[k], cx(d.padroes[k]), 1e-12);
  }
  const medidos = {};
  for (const k of Object.keys(d.medidos)) medidos[k] = cx(d.medidos[k].s11);
  const t = solt.resolveUmaPorta(f, medidos, d.kit);
  cmpC("termo e00 (diretividade)", t.e00, cx(d.e00), 1e-10);
  cmpC("termo e11 (casamento)", t.e11, cx(d.e11), 1e-10);
  cmpC("termo e10e01 (rastreio)", t.e10e01, cx(d.e10e01), 1e-10);
  cmp("número de condição", Array.from(t.cond), d.cond, 1e-10);
  const tr = solt.resolveTransmissao(f, cx(d.medidos.thru.s21), null, d.kit);
  cmpC("termo e10e32 (transmissão)", tr.e10e32, cx(d.e10e32), 1e-10);
  Object.assign(t, tr);
  const c = solt.corrige(t, cx(d.medidos.aberto.s11), cx(d.medidos.thru.s21));
  cmpC("correção do S11", c.s11, cx(d.corr11));
  cmpC("correção do S21", c.s21, cx(d.corr21));
  const ti = solt.interpola(t, Float64Array.from(d.fn));
  cmpC("interpolação de e00", ti.e00, cx(d.int_e00));
  cmpC("interpolação de e10e01", ti.e10e01, cx(d.int_e10e01));
  const rev = solt.reverifica(f, t, medidos, d.kit);
  relata("veredito da reverificação", rev.veredito === d.reverifica.veredito,
         rev.veredito + " (a carga corrigida fica no piso numérico nos dois "
         + "lados: −337 dB aqui, −319 dB no Python)");
}

// ----------------------------------------------------------------- curva
console.log("\ncurva de calibração");
{
  const d = R.curva;
  const lin = cv.ajustaCurva(d.x, d.y, { tipo: "linear", sigma_y: 0.05,
    sigma_origem: "medida", unidade_x: "%vol", unidade_y: "MHz" });
  cmp("ajuste linear", lin.coefs, d.linear.coefs);
  cmp("linear, covariância", lin.cov, d.linear.cov, 1e-11);
  cmp("R², s_yx, LOD, LOQ", [lin.r2, lin.s_yx, lin.lod, lin.loq],
      [d.linear.r2, d.linear.s_yx, d.linear.lod, d.linear.loq]);
  const p2 = cv.ajustaCurva(d.x, d.y, { tipo: "poli2", unidade_x: "%vol",
                                        unidade_y: "MHz" });
  cmp("ajuste poli2", p2.coefs, d.poli2.coefs, 1e-8);
  cmp("poli2, sensibilidade", [p2.sensibilidade], [d.poli2.sensibilidade], 1e-8);
  const te = cv.ajustaCurva(d.x, d.y, { tipo: "covariavel", cov_valores: d.t,
    unidade_x: "%vol", unidade_y: "MHz", nome_cov: "temperatura",
    unidade_cov: "°C" });
  cmp("ajuste com covariável", te.coefs, d.covariavel.coefs, 1e-9);
  cmp("coeficiente da covariável", [te.coef_cov, te.cov_ref],
      [d.covariavel.coef_cov, d.covariavel.cov_ref], 1e-9);
  // O nome velho do tipo tem de continuar entrando: há curvas gravadas com ele.
  const teVelho = cv.ajustaCurva(d.x, d.y, { tipo: "termico", cov_valores: d.t,
    unidade_x: "%vol", unidade_y: "MHz" });
  cmp("apelido `termico` do tipo", teVelho.coefs, d.covariavel.coefs, 1e-9);
  const fx = cv.ajustaCurva(d.x, d.y, { tipo: "linear", faixa: [2.0, 12.0],
    unidade_x: "%vol", unidade_y: "MHz" });
  cmp("ajuste com faixa", [fx.n].concat(fx.coefs),
      [d.faixado.n].concat(d.faixado.coefs));
  const il = cv.inversa(lin, d.y[3], { m: 5 });
  cmp("inversa linear (X e barra)", [il.x, il.u, il.meia_largura],
      [d.inv_linear.x, d.inv_linear.u, d.inv_linear.meia_largura]);
  const ip = cv.inversa(p2, d.y[3], { m: 5 });
  cmp("inversa poli2 (X)", [ip.x], [d.inv_poli2.x], 1e-8);
  // O Monte Carlo usa geradores diferentes dos dois lados. A barra é
  // estatística, e concordar em 5 % sobre 2000 amostras é o esperado.
  const du = Math.abs(ip.u - d.inv_poli2.u) / d.inv_poli2.u;
  relata("inversa poli2 (barra, Monte Carlo)", du <= 0.05,
         "diferença de " + (du * 100).toFixed(1) + " %, limite 5 %");
  const fora = cv.inversa(lin, 2000.0);
  relata("inversa fora da faixa recusa", !!fora.erro && !!d.inv_fora.erro,
         fora.erro ? "recusou" : "ACEITOU, e não devia");
  const r2 = cv.varreduraR2(d.freqs, d.matriz, d.x);
  cmp("varredura de R²", r2.r2, d.r2.r2);
  cmp("melhor frequência e R²", [r2.melhor_hz, r2.melhor_r2],
      [d.r2.melhor_hz, d.r2.melhor_r2]);
  const resumo = cv.textoResumo(lin, "%vol", "MHz");
  relata("texto do resumo", resumo === d.resumo,
         resumo === d.resumo ? "idêntico" : JSON.stringify(resumo));
}

// -------------------------------------------------------------- arquivos
console.log("\nformatos de arquivo (a ponte com a análise em Python)");
{
  const d = R.arquivos;
  const f = Float64Array.from(d.f);
  const s11 = cx(d.s11), s21 = cx(d.s21);
  const csv = az.escreveCsvLitevna(f, s11, s21);
  relata("CSV nativo do LiteVNA", csv === d.csv,
         csv === d.csv ? "idêntico byte a byte" : "difere");
  const corta = (t) => t.slice(t.indexOf("# Hz"));
  const s2p = az.escreveTouchstone(f, s11, s21,
    { sessao: "teste", seq: 7, aparelho: "simulado" });
  relata("Touchstone .s2p", corta(s2p) === corta(d.s2p),
         corta(s2p) === corta(d.s2p)
           ? "idêntico da linha de formato em diante" : "difere");
}

console.log("\n" + (falhas ? falhas + " de " + casos + " casos FALHARAM"
                           : "os " + casos + " casos conferem"));
process.exit(falhas ? 1 : 0);
