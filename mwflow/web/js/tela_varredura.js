"use strict";
/* Tela 1 — varredura ao vivo.

   O cliente recebe S11 e S21 complexos e calcula o formato escolhido aqui
   mesmo. Assim trocar de dB para fase é instantâneo e não exige nova
   varredura. */

MW.varredura = (function () {
  let plot = null, congelado = false, ultima = null, ultimoAjuste = null;
  let retido = null;

  const FORMATO = {
    mag_db:   { rot: "|S| (dB)", casas: 1, fn: (re, im) => 10 * Math.log10(re * re + im * im) },
    mag_lin:  { rot: "|S|", casas: 3, fn: (re, im) => Math.hypot(re, im) },
    fase_deg: { rot: "fase (graus)", casas: 0, fn: (re, im) => Math.atan2(im, re) * 180 / Math.PI },
    fase_desdobrada: { rot: "fase desdobrada (graus)", casas: 0, desdobra: true,
                       fn: (re, im) => Math.atan2(im, re) * 180 / Math.PI },
    vswr:     { rot: "VSWR", casas: 2, fn: function (re, im) {
                  const m = Math.min(0.999999, Math.hypot(re, im));
                  return (1 + m) / (1 - m); } },
    z_re:     { rot: "Re(Z) (ohm)", casas: 1, fn: function (re, im) {
                  const d = (1 - re) * (1 - re) + im * im;
                  return 50 * (1 - re * re - im * im) / d; } },
    z_im:     { rot: "Im(Z) (ohm)", casas: 1, fn: function (re, im) {
                  const d = (1 - re) * (1 - re) + im * im;
                  return 50 * (2 * im) / d; } },
    atraso_grupo: { rot: "atraso de grupo (ns)", casas: 2, atraso: true, fn: null },
  };

  function converte(vet, fmt) {
    const n = vet.re.length, y = new Array(n);
    if (fmt.atraso) {
      const fase = new Array(n);
      let ac = 0, ant = 0;
      for (let i = 0; i < n; i++) {
        let p = Math.atan2(vet.im[i], vet.re[i]);
        if (i > 0) { let d = p - ant; if (d > Math.PI) ac -= 2 * Math.PI;
                     else if (d < -Math.PI) ac += 2 * Math.PI; }
        ant = p; fase[i] = p + ac;
      }
      const df = (ultima.f_passo_hz || 1);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        y[i] = -(fase[b] - fase[a]) / (2 * Math.PI * df * (b - a)) * 1e9;
      }
      return y;
    }
    let ac = 0, ant = 0;
    for (let i = 0; i < n; i++) {
      let v = fmt.fn(vet.re[i], vet.im[i]);
      if (fmt.desdobra) {
        if (i > 0) { let d = v - ant; if (d > 180) ac -= 360; else if (d < -180) ac += 360; }
        ant = v; v += ac;
      }
      y[i] = isFinite(v) ? v : null;
    }
    return y;
  }

  function cria() {
    const el = MW.q("#g-varredura");
    const fmt = FORMATO[MW.q("#formato-varredura").value];
    const opts = {
      width: 800, height: 380,
      cursor: { drag: { x: true, y: false } },
      scales: { x: { time: false } },
      axes: [MW.eixo("Frequência (MHz)", 0), MW.eixo(fmt.rot, fmt.casas)],
      series: [
        { label: "f (MHz)", value: (u, v) => MW.num(v, 3) },
        MW.serie("S11", MW.cor.cat[0]),
        MW.serie("S21", MW.cor.cat[1]),
        Object.assign(MW.serie("modelo", MW.cor.seq[3], 1.2), { dash: [6, 3] }),
        Object.assign(MW.serie("máximo retido", MW.cor.seq[0], 1)),
      ],
      hooks: {
        draw: [function (u) {
          /* Faixa sombreada = banda do ajuste. Ver onde o ajuste olha é
             metade do diagnóstico. */
          if (!ultimoAjuste || !ultimoAjuste.banda_hz) return;
          const b = ultimoAjuste.banda_hz;
          const x0 = u.valToPos(b[0] / 1e6, "x", true);
          const x1 = u.valToPos(b[1] / 1e6, "x", true);
          const c = u.ctx;
          c.save();
          c.fillStyle = "rgba(126,200,216,.13)";
          c.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
          if (ultimoAjuste.valores && ultimoAjuste.valores.f_res) {
            const xf = u.valToPos(ultimoAjuste.valores.f_res / 1e6, "x", true);
            c.strokeStyle = ultimoAjuste.ok ? MW.cor.seq[3] : MW.cor.cat[1];
            c.setLineDash([3, 3]); c.lineWidth = 1;
            c.beginPath(); c.moveTo(xf, u.bbox.top);
            c.lineTo(xf, u.bbox.top + u.bbox.height); c.stroke();
          }
          c.restore();
        }],
      },
    };
    plot = new uPlot(opts, [[0], [null], [null], [null], [null]], el);
    MW.ajusta(plot, el);
  }

  function modeloEm(fMHz, m, a) {
    /* S(f) = C + A / (1 + 2jQ(f-f0)/f0) */
    const c_re = m[0], c_im = m[1], a_re = m[2], a_im = m[3];
    const f0 = a.f_res, q = a.q;
    const re = new Float32Array(fMHz.length), im = new Float32Array(fMHz.length);
    for (let i = 0; i < fMHz.length; i++) {
      const x = 2 * q * (fMHz[i] * 1e6 - f0) / f0;   /* parte imaginária */
      const d = 1 + x * x;
      const lr = 1 / d, li = -x / d;
      re[i] = c_re + a_re * lr - a_im * li;
      im[i] = c_im + a_re * li + a_im * lr;
    }
    return { re: re, im: im };
  }

  function desenha() {
    if (!ultima || congelado) return;
    const fmt = FORMATO[MW.q("#formato-varredura").value];
    const n = ultima.n;
    const f = new Array(n);
    for (let i = 0; i < n; i++) f[i] = (ultima.f_inicio_hz + i * ultima.f_passo_hz) / 1e6;

    const s11 = MW.q("#mostra-s11").checked
      ? converte(ultima.vetores[0], fmt) : MW.vazio(n);
    const s21 = MW.q("#mostra-s21").checked
      ? converte(ultima.vetores[1], fmt) : MW.vazio(n);

    let mod = MW.vazio(n);
    if (MW.q("#mostra-ajuste").checked && ultimoAjuste && ultimoAjuste.modelo
        && ultimoAjuste.valores && ultimoAjuste.ok) {
      const cheio = converte(modeloEm(f, ultimoAjuste.modelo,
                                      ultimoAjuste.valores), fmt);
      /* O modelo só vale DENTRO da banda ajustada. Desenhá-lo fora dela
         sugeriria que o ajuste explica uma região que ele nem olhou. */
      const lo = ultimoAjuste.banda_hz[0] / 1e6;
      const hi = ultimoAjuste.banda_hz[1] / 1e6;
      for (let i = 0; i < n; i++) {
        if (f[i] >= lo && f[i] <= hi) mod[i] = cheio[i];
      }
    }

    const alvo = ultima.param === "s11" ? s11 : s21;
    if (MW.q("#reter-max").checked) {
      if (!retido || retido.length !== n) retido = alvo.slice();
      else for (let i = 0; i < n; i++) {
        if (alvo[i] !== null && (retido[i] === null || alvo[i] > retido[i]))
          retido[i] = alvo[i];
      }
    } else retido = MW.vazio(n);

    plot.axes[1].label = fmt.rot;
    plot.setData([f, s11, s21, mod, retido || MW.vazio(n)]);
    leitura();
  }

  function leitura() {
    const el = MW.q("#leitura-ajuste");
    if (!ultimoAjuste) { el.textContent = ""; return; }
    const v = ultimoAjuste.valores;
    if (!v) {
      el.innerHTML = '<span class="mau">sem ajuste: ' +
        (ultimoAjuste.motivo || "—") + "</span>";
      return;
    }
    let h = "";
    h += '<span class="rot">f_res</span><span class="val">' + MW.eng(v.f_res) + "</span>";
    h += '<span class="rot">Q</span><span class="val">' + MW.num(v.q, 2) + "</span>";
    h += '<span class="rot">IL</span><span class="val">' + MW.num(v.il_db, 2) + " dB</span>";
    h += '<span class="rot">largura</span><span class="val">' + MW.num(v.fwhm_mhz, 2) + " MHz</span>";
    h += '<span class="rot">proeminência</span><span class="val">' + MW.num(v.prominencia_db, 2) + " dB</span>";
    h += '<span class="rot">rms</span><span class="val">' + MW.num(v.rms, 5) + "</span>";
    h += '<span class="rot">banda</span><span class="val">'
      + MW.num(ultimoAjuste.banda_hz[0] / 1e6, 1) + " a "
      + MW.num(ultimoAjuste.banda_hz[1] / 1e6, 1) + " MHz</span>";
    if (!ultimoAjuste.ok) {
      h += '<span class="mau">REPROVADO: ' + (ultimoAjuste.motivo || "") + "</span>";
    }
    el.innerHTML = h;
  }

  function inicia() {
    cria();
    MW.ws.em("varredura", function (m) {
      ultima = m;
      desenha();
    });
    MW.ws.em("escalar", function (m) {
      ultimoAjuste = m;
      if (!congelado) leitura();
    });
    MW.q("#formato-varredura").addEventListener("change", function () {
      const fmt = FORMATO[this.value];
      plot.axes[1].values = function (u, vs) {
        return vs.map(v => MW.num(v, fmt.casas));
      };
      retido = null;
      desenha();
    });
    ["#mostra-s11", "#mostra-s21", "#mostra-ajuste", "#reter-max"].forEach(function (s) {
      MW.q(s).addEventListener("change", function () { retido = null; desenha(); });
    });
    MW.q("#congela-varredura").addEventListener("click", function () {
      congelado = !congelado;
      this.textContent = congelado ? "Descongelar" : "Congelar";
      this.classList.toggle("primario", congelado);
    });
    MW.q("#salva-varredura").addEventListener("click", function () {
      MW.ws.manda({ t: "salvar_varredura" });
      MW.mensagem("varredura salva na sessão");
    });
    window.addEventListener("resize", function () {
      MW.ajusta(plot, MW.q("#g-varredura"));
    });
  }

  return {
    inicia: inicia,
    redimensiona: function () { MW.ajusta(plot, MW.q("#g-varredura")); },
    /* sonda de diagnóstico, usada pelo teste de navegador */
    dbg: function () {
      return { temUltima: !!ultima, n: ultima ? ultima.n : null,
               nVet: ultima && ultima.vetores ? ultima.vetores.length : null,
               primeiro: ultima && ultima.vetores && ultima.vetores[0]
                 ? ultima.vetores[0].re[0] : null,
               dadosPlot: plot ? plot.data.map(function (d) {
                 return d === null ? "NULO" : d.length; }) : null };
    },
  };
})();
