"use strict";
/* Utilidades comuns: números em português, paleta e eixos do uPlot. */

const MW = {
  cor: {
    seq: ["#7ec8d8", "#3ba3bd", "#0f7d99", "#08536b"],
    cat: ["#0089a8", "#a53c74"],
    tinta: "#22262b", tinta2: "#6b7280", grade: "#e4e6ea",
  },
};

/* `const` no topo de um script clássico NÃO vira propriedade de `window`. Os
   módulos do núcleo local precisam alcançar o MW, então a ponte é explícita. */
window.MW = MW;

/* Vírgula decimal, como nas figuras do artigo. */
MW.num = function (v, casas) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return v.toLocaleString("pt-BR", {
    minimumFractionDigits: casas === undefined ? 3 : casas,
    maximumFractionDigits: casas === undefined ? 3 : casas,
  });
};

/* Rótulo de EIXO nunca leva separador de milhar. Em português o separador é o
   ponto, e num eixo em MHz o rótulo "1.504" se lê como 1,504 — o engano mais
   caro possível numa escala. O separador ajuda a ler um número solto; numa
   escala de dez rótulos ele só atrapalha. */
MW.numEixo = function (v, casas) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return v.toLocaleString("pt-BR", {
    minimumFractionDigits: casas, maximumFractionDigits: casas,
    useGrouping: false,
  });
};

/* Número com as casas que a GRANDEZA dele pede, e não um número fixo delas.
   Um erro padrão de 1.368.966 não precisa de cinco casas; um de 0,0041
   precisa. Fora da faixa que se lê de relance, o número sai em potência de
   dez. */
MW.sig = function (v, algarismos) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const n = algarismos || 4;
  if (v === 0) return MW.num(0, n - 1);
  const ordem = Math.floor(Math.log10(Math.abs(v)));
  if (ordem >= 6 || ordem <= -5) {
    return v.toExponential(n - 1).replace(".", ",");
  }
  return MW.num(v, Math.max(0, n - 1 - ordem));
};

MW.eng = function (hz) {
  if (!isFinite(hz)) return "—";
  const a = Math.abs(hz);
  if (a >= 1e9) return MW.num(hz / 1e9, 6) + " GHz";
  if (a >= 1e6) return MW.num(hz / 1e6, 3) + " MHz";
  if (a >= 1e3) return MW.num(hz / 1e3, 3) + " kHz";
  return MW.num(hz, 1) + " Hz";
};

MW.q = function (sel) { return document.querySelector(sel); };

/* Toda chamada de rota passa por aqui, e nunca pelo `fetch` direto.
   No modo servidor isto É o fetch. No modo local, `js/nucleo/local.js` troca
   esta função por um roteador que responde do próprio navegador. As telas não
   sabem em qual dos dois estão, e é isso que permite as duas versões
   dividirem o mesmo código de interface. */
MW.api = function (caminho, opcoes) { return fetch(caminho, opcoes); };

/* Salva um conteúdo como arquivo. No modo servidor os arquivos também vão
   para a pasta da sessão; aqui é a cópia que o operador leva na hora. */
MW.baixa = function (nome, conteudo, tipo) {
  const b = conteudo instanceof Blob
    ? conteudo : new Blob([conteudo], { type: tipo || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
};

/* uPlot quebra se uma SÉRIE inteira for null: ele lê `.length` dela. Um valor
   null dentro do vetor é aceito; o vetor null não é. Este ajudante devolve a
   série ausente do jeito que o uPlot espera. */
MW.vazio = function (n) { return new Array(n).fill(null); };
MW.qq = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

/* Casas decimais tiradas do espaçamento entre os traços do eixo.
   Casas fixas erram nos dois sentidos: com um eixo de 1500,281 a 1500,289 MHz,
   três casas fazem todos os rótulos saírem iguais; com um eixo de 0 a 3 GHz,
   elas só acrescentam zeros. */
function casasDe(vs) {
  let passo = Infinity;
  for (let i = 1; i < vs.length; i++) {
    const d = Math.abs(vs[i] - vs[i - 1]);
    if (d > 0 && d < passo) passo = d;
  }
  if (!isFinite(passo)) return 3;
  return Math.min(6, Math.max(0, Math.ceil(-Math.log10(passo))));
}

/* Largura do eixo vertical pelo maior rótulo que ele vai escrever.
   O uPlot não mede isso sozinho: o padrão são 50 px, e "1.540,90212" não cabe
   ali — o número sai cortado. O eixo horizontal fica com a altura padrão. */
function tamanhoEixo(u, vs, idx) {
  const lado = u.axes[idx].side;
  if (lado === 0 || lado === 2) return 30;
  let n = 0;
  (vs || []).forEach(function (s) { n = Math.max(n, String(s).length); });
  return Math.min(120, Math.max(38, n * 6.6 + 16));
}

/* Eixos do uPlot no estilo da casa: sem moldura em cima e à direita,
   grade discreta e vírgula decimal nos rótulos. `casas` aceita o número de
   casas decimais ou "auto", que as tira do espaçamento dos traços. */
MW.eixo = function (rotulo, casas) {
  return {
    label: rotulo,
    labelSize: 44,
    labelFont: "12px system-ui",
    font: "11px system-ui",
    stroke: MW.cor.tinta2,
    grid: { stroke: MW.cor.grade, width: 1 },
    ticks: { stroke: MW.cor.grade, width: 1, size: 4 },
    size: tamanhoEixo,
    values: function (u, vs) {
      const c = casas === "auto" ? casasDe(vs)
        : (casas === undefined ? 1 : casas);
      return vs.map(function (v) { return MW.numEixo(v, c); });
    },
  };
};

/* Faixa de um eixo que precisa mostrar mais do que os pontos: a barra de erro
   que sai deles, ou o zero de uma referência. Sem isto o uPlot ajusta a escala
   só aos valores, e o que for desenhado fora dela é cortado na borda. */
MW.faixa = function (lo, hi, extra) {
  extra = extra || {};
  if (lo === null || hi === null || !isFinite(lo) || !isFinite(hi)) {
    return [0, 1];
  }
  const s = extra.folga_dado || 0;
  lo -= s;
  hi += s;
  if (extra.inclui_zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi <= lo) {                       // todos os valores iguais
    const d = Math.abs(hi) * 1e-6 || 1;
    lo -= d; hi += d;
  }
  const folga = (hi - lo) * (extra.margem === undefined ? 0.06 : extra.margem);
  return [lo - folga, hi + folga];
};

MW.serie = function (rotulo, cor, largura) {
  return {
    label: rotulo, stroke: cor, width: largura || 1.5,
    points: { show: false },
    value: function (u, v) { return v === null ? "—" : MW.num(v, 3); },
  };
};

/* Redimensiona um gráfico uPlot para o elemento que o contém.
   A LEGENDA NÃO ENTRA NA ALTURA QUE O `setSize` PEDE: ela é uma tabela abaixo
   da área de desenho. Sem descontá-la, o gráfico passa da caixa pela altura da
   legenda e cai por cima do que vier depois — do rótulo do resíduo, do
   cabeçalho da tabela de pontos. */
MW.ajusta = function (plot, el) {
  if (!plot || !el) return;
  const r = el.getBoundingClientRect();
  const leg = plot.root ? plot.root.querySelector(".u-legend") : null;
  const alturaLegenda = leg ? leg.getBoundingClientRect().height : 0;
  const altura = Math.floor(r.height - 16 - alturaLegenda);
  if (r.width > 20 && altura > 20) {
    plot.setSize({ width: Math.floor(r.width - 16), height: altura });
  }
};

/* Buffer circular de tamanho fixo, para o osciloscópio.
   Nunca realoca: alocar 260 mil floats a 270 Hz seria coleta de lixo sem fim. */
MW.Anel = class {
  constructor(n) {
    this.n = n; this.x = new Float64Array(n); this.y = new Float64Array(n);
    this.cheio = false; this.i = 0;
  }
  poe(x, y) {
    this.x[this.i] = x; this.y[this.i] = y;
    this.i = (this.i + 1) % this.n;
    if (this.i === 0) this.cheio = true;
  }
  get tamanho() { return this.cheio ? this.n : this.i; }
  limpa() { this.cheio = false; this.i = 0; }
  /* Devolve os pontos em ordem cronológica, dentro de uma janela em segundos. */
  serie(janela) {
    const n = this.tamanho;
    if (n === 0) return [[], []];
    const xs = new Float64Array(n), ys = new Float64Array(n);
    const ini = this.cheio ? this.i : 0;
    for (let k = 0; k < n; k++) {
      const j = (ini + k) % this.n;
      xs[k] = this.x[j]; ys[k] = this.y[j];
    }
    if (!janela) return [Array.from(xs), Array.from(ys)];
    const corte = xs[n - 1] - janela;
    let a = 0;
    while (a < n && xs[a] < corte) a++;
    return [Array.from(xs.subarray(a)), Array.from(ys.subarray(a))];
  }
};

/* Decimação por mínimo e máximo, dois pontos por coluna de pixel.
   Decimar por salto simples esconderia transientes — exatamente o que se
   quer ver quando passa uma bolha. */
MW.decima = function (xs, ys, largura) {
  const n = xs.length;
  if (n <= largura * 2 || largura < 2) return [xs, ys];
  const passo = n / largura;
  const X = [], Y = [];
  for (let c = 0; c < largura; c++) {
    const a = Math.floor(c * passo), b = Math.min(n, Math.floor((c + 1) * passo));
    if (b <= a) continue;
    let lo = Infinity, hi = -Infinity, ilo = a, ihi = a;
    for (let k = a; k < b; k++) {
      const v = ys[k];
      if (v < lo) { lo = v; ilo = k; }
      if (v > hi) { hi = v; ihi = k; }
    }
    if (ilo <= ihi) { X.push(xs[ilo], xs[ihi]); Y.push(lo, hi); }
    else { X.push(xs[ihi], xs[ilo]); Y.push(hi, lo); }
  }
  return [X, Y];
};
