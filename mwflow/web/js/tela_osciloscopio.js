"use strict";
/* Tela 2 — osciloscópio: a grandeza escolhida contra o tempo.

   Dois regimes, e o ACOPLAMENTO ENTRE ELES É AUTOMÁTICO:

   - Grandeza de traço (|S| em dB, fase, VSWR): pede frequência fixa. Cerca de
     320 amostras por segundo. É o regime para transiente rápido — bolha,
     vazão, vibração — onde a amplitude numa frequência é mesmo o sinal.
   - Grandeza derivada (f_res, Q, IL): pede varredura, porque f_res NÃO EXISTE
     numa frequência só. Cerca de 3 pontos por segundo com 101 pontos. É o
     regime para deriva e para o experimento de sensor.

   Escolher `f_res` e ficar em frequência fixa seria pedir um número que não
   existe. Por isso a tela troca o modo do aparelho sozinha e diz que trocou. */

MW.osciloscopio = (function () {
  let plot = null, anel = new MW.Anel(262144), pausado = false;
  let t0 = null, eventos = [], ultimoRot = "", ultimaUnid = "";

  function alvo() {
    const v = MW.q("#obs-osc").value || "derivado:f_res";
    const p = v.split(":");
    return { tipo: p[0], id: p[1] };
  }

  function valorDeTraco(id, re, im) {
    switch (id) {
      case "mag_db": return 10 * Math.log10(re * re + im * im);
      case "mag_lin": return Math.hypot(re, im);
      case "fase_deg": case "fase_desdobrada": return Math.atan2(im, re) * 180 / Math.PI;
      case "re": return re;
      case "im": return im;
      case "vswr": { const m = Math.min(0.999999, Math.hypot(re, im)); return (1 + m) / (1 - m); }
      case "z_re": { const d = (1 - re) * (1 - re) + im * im; return 50 * (1 - re * re - im * im) / d; }
      case "z_im": { const d = (1 - re) * (1 - re) + im * im; return 50 * (2 * im) / d; }
      default: return Math.hypot(re, im);
    }
  }

  /* f_res em hertz enche o eixo de zeros e some com o número. Sempre que a
     unidade for Hz, o gráfico passa para MHz. */
  function escala() {
    return unidade() === "Hz" ? { k: 1e6, u: "MHz" } : { k: 1, u: unidade() };
  }

  function rotulo() {
    const a = alvo();
    const e = escala();
    const base = a.tipo === "traco"
      ? (((MW.estado.observaveis || []).find(x => x.id === a.id) || {}).rotulo || a.id)
      : ((MW.estado.rotulo_escalar || {})[a.id] || a.id);
    if (a.tipo === "traco") return base;
    return e.u ? base + " (" + e.u + ")" : base;
  }

  function cria() {
    const el = MW.q("#g-osciloscopio");
    plot = new uPlot({
      width: 800, height: 380,
      cursor: { drag: { x: true, y: false } },
      scales: { x: { time: false } },
      axes: [MW.eixo("Tempo (s)", 1), MW.eixo("valor", 3)],
      series: [
        { label: "t (s)", value: (u, v) => MW.num(v, 2) },
        MW.serie("medido", MW.cor.cat[0], 1.3),
      ],
      hooks: {
        draw: [function (u) {
          if (!eventos.length) return;
          const c = u.ctx; c.save();
          c.strokeStyle = MW.cor.cat[1]; c.setLineDash([2, 2]); c.lineWidth = 1;
          c.fillStyle = MW.cor.cat[1]; c.font = "10px system-ui";
          eventos.forEach(function (ev) {
            const x = u.valToPos(ev.t, "x", true);
            if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
            c.beginPath(); c.moveTo(x, u.bbox.top);
            c.lineTo(x, u.bbox.top + u.bbox.height); c.stroke();
            c.fillText(ev.rot, x + 3, u.bbox.top + 10);
          });
          c.restore();
        }],
      },
    }, [[0], [null]], el);
    MW.ajusta(plot, el);
  }

  function poe(t, v) {
    if (pausado || v === null || !isFinite(v)) return;
    if (t0 === null) t0 = t;
    anel.poe(t - t0, v);
  }

  function desenha() {
    const janela = parseFloat(MW.q("#janela-osc").value);
    let [xs, ys] = anel.serie(janela);
    if (!xs.length) return;
    const largura = Math.max(200, plot.bbox.width || 800);
    const k = escala().k;
    const [dx, dy] = MW.decima(xs, k === 1 ? ys : ys.map(v => v / k), largura);
    plot.axes[1].label = rotulo();
    plot.axes[1].values = function (u, vs) {
      return vs.map(v => MW.num(v, k === 1 ? 3 : 4));
    };
    plot.setData([dx, dy]);
    estatisticas(xs, ys);
  }

  function estatisticas(xs, ys) {
    const n = ys.length;
    if (!n) return;
    let s = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) { s += ys[i]; if (ys[i] < mn) mn = ys[i]; if (ys[i] > mx) mx = ys[i]; }
    const med = s / n;
    let v = 0; for (let i = 0; i < n; i++) v += (ys[i] - med) * (ys[i] - med);
    const dp = Math.sqrt(v / Math.max(1, n - 1));

    /* Deriva: inclinação da reta na janela visível. */
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const den = n * sxx - sx * sx;
    const incl = den !== 0 ? (n * sxy - sx * sy) / den : 0;

    /* σ dos últimos 60 s: é este número que substitui a precisão SUPOSTA de
       1 MHz no cálculo do limite de detecção. */
    const corte = xs[n - 1] - 60;
    let a = 0; while (a < n && xs[a] < corte) a++;
    let s2 = 0, k = 0;
    for (let i = a; i < n; i++) { s2 += ys[i]; k++; }
    const m2 = k ? s2 / k : NaN;
    let v2 = 0; for (let i = a; i < n; i++) v2 += (ys[i] - m2) * (ys[i] - m2);
    const dp60 = k > 1 ? Math.sqrt(v2 / (k - 1)) : NaN;

    const e = escala();
    const esc = e.k, su = e.u;

    MW.q("#leitura-osc").innerHTML =
      '<span class="rot">n</span><span class="val">' + n + "</span>" +
      '<span class="rot">média</span><span class="val">' + MW.num(med / esc, 4) + " " + su + "</span>" +
      '<span class="rot">desvio</span><span class="val">' + MW.num(dp / esc, 5) + " " + su + "</span>" +
      '<span class="rot">pico a pico</span><span class="val">' + MW.num((mx - mn) / esc, 5) + " " + su + "</span>" +
      '<span class="rot">deriva</span><span class="val">' + MW.num(incl * 60 / esc, 5) + " " + su + "/min</span>" +
      '<span class="rot">σ de 60 s</span><span class="val" id="sigma60">' + MW.num(dp60 / esc, 5) + " " + su + "</span>" +
      '<button id="usa-sigma">usar este σ no limite de detecção</button>';

    const b = MW.q("#usa-sigma");
    if (b) b.addEventListener("click", function () {
      MW.q("#sigma-valor").value = (dp60 / esc).toPrecision(4);
      MW.q("#sigma-origem").value = "medida";
      MW.mensagem("σ medido levado para a tela da curva de calibração");
    });
  }

  function unidade() {
    const a = alvo();
    if (a.tipo === "derivado") return (MW.estado.unidade_escalar || {})[a.id] || "";
    const o = (MW.estado.observaveis || []).find(x => x.id === a.id);
    return o ? o.unidade : "";
  }

  function exigeModo() {
    const a = alvo();
    const querido = a.tipo === "derivado" ? "varredura" : "cw";
    const dica = MW.q("#dica-osc");
    if (a.tipo === "derivado") {
      dica.textContent = "f_res e Q vêm de um ajuste sobre uma banda: "
        + "o aparelho fica em varredura.";
    } else {
      dica.textContent = "grandeza pontual: o aparelho vai para frequência fixa, "
        + "cerca de 320 amostras por segundo.";
    }
    if (MW.estado.modo !== querido && MW.estado.modo !== "parado") {
      MW.ws.manda({ t: "modo", modo: querido });
      MW.q("#modo").value = querido;
      MW.mensagem("modo trocado para " + (querido === "cw" ? "frequência fixa" : "varredura")
        + " por causa da grandeza escolhida");
    }
    anel.limpa(); t0 = null; eventos = [];
  }

  function inicia() {
    cria();

    MW.ws.em("amostras_cw", function (m) {
      if (alvo().tipo !== "traco") return;
      const id = alvo().id, v = m.vetores[1], t = m.vetores[0];
      for (let i = 0; i < m.n; i++) {
        poe(m.t0 + t[i], valorDeTraco(id, v.re[i], v.im[i]));
      }
      if (MW.telaAtual === "osciloscopio") desenha();
    });

    MW.ws.em("escalar", function (m) {
      if (alvo().tipo !== "derivado") return;
      if (!m.ok || !m.valores) {
        if (m.motivo) MW.mensagem("ponto recusado — " + m.motivo);
        return;
      }
      poe(m.t, m.valores[alvo().id]);
      if (MW.telaAtual === "osciloscopio") desenha();
    });

    MW.q("#obs-osc").addEventListener("change", exigeModo);
    MW.q("#janela-osc").addEventListener("change", desenha);
    MW.q("#pausa-osc").addEventListener("click", function () {
      pausado = !pausado;
      this.textContent = pausado ? "Continuar" : "Pausar";
      this.classList.toggle("primario", pausado);
    });
    MW.q("#limpa-osc").addEventListener("click", function () {
      anel.limpa(); t0 = null; eventos = []; desenha();
    });
    MW.q("#marca-evento").addEventListener("click", function () {
      const rot = prompt("Rótulo do evento (ex.: abri a válvula):", "");
      if (rot === null) return;
      const n = anel.tamanho;
      const t = n ? anel.serie(0)[0][n - 1] : 0;
      eventos.push({ t: t, rot: rot });
      MW.ws.manda({ t: "evento", rotulo: rot });
      desenha();
    });
    window.addEventListener("resize", function () {
      MW.ajusta(plot, MW.q("#g-osciloscopio"));
    });
  }

  return {
    inicia: inicia,
    redimensiona: function () { MW.ajusta(plot, MW.q("#g-osciloscopio")); desenha(); },
  };
})();
