"use strict";
/* Tela 3 — espectrograma: magnitude contra frequência e tempo.

   POR QUE CANVAS À MÃO E NÃO UMA BIBLIOTECA. Nenhuma biblioteca de gráficos
   desenha um mapa de calor que rola a 60 quadros por segundo. A receita aqui:

   1. Um anel `Float32Array(nHist × nFreq)` guarda os valores em dB, NÃO os
      pixels. Guardar pixel impediria trocar a escala ou as cores sem perder o
      histórico.
   2. Uma tabela de 256 cores traduz dB em RGBA.
   3. Um canvas fora de tela, do tamanho exato da grade. Cada varredura nova
      escreve UMA linha, com `putImageData`.
   4. A cada quadro, dois `drawImage` desenrolam o anel para o canvas visível.
      São duas cópias aceleradas pela placa de vídeo e um envio de uma linha.

   O truque de rolar o canvas sobre si mesmo (`drawImage(canvas, 0, 1)`) foi
   descartado de propósito: ele reamostra a imagem inteira todo quadro, acumula
   erro de interpolação e torna impossível recolorir. */

MW.espectrograma = (function () {
  let nFreq = 0, nHist = 600, anel = null, cabeca = 0, cheio = false;
  let fora = null, foraCtx = null, linhaImg = null;
  let vis = null, visCtx = null, eixos = null, eixosCtx = null;
  let lut = null, dbMin = -90, dbMax = 0, f0 = 0, df = 0;
  let pendente = false, tempos = null;

  /* ------------------------------------------------------------ cores */
  function mistura(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  const RAMPAS = {
    /* A rampa da casa, esticada nas duas pontas para cobrir a faixa toda
       mantendo a luminância monótona. */
    casa: [[255,255,255],[126,200,216],[59,163,189],[15,125,153],[8,83,107],[4,34,44]],
    viridis: [[68,1,84],[59,82,139],[33,145,140],[94,201,98],[253,231,37]],
    cinza: [[255,255,255],[0,0,0]],
  };
  function fazLut(nome) {
    const p = RAMPAS[nome] || RAMPAS.casa;
    const u = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const x = i / 255 * (p.length - 1);
      const k = Math.min(p.length - 2, Math.floor(x));
      const c = mistura(p[k], p[k + 1], x - k);
      u[i * 4] = c[0]; u[i * 4 + 1] = c[1]; u[i * 4 + 2] = c[2]; u[i * 4 + 3] = 255;
    }
    return u;
  }

  /* ------------------------------------------------------- redimensiona */
  function prepara(n) {
    if (n === nFreq && anel && anel.length === nHist * nFreq) return;
    nFreq = n;
    anel = new Float32Array(nHist * nFreq).fill(NaN);
    tempos = new Float64Array(nHist);
    cabeca = 0; cheio = false;
    fora = document.createElement("canvas");
    fora.width = nFreq; fora.height = nHist;
    foraCtx = fora.getContext("2d", { willReadFrequently: false });
    foraCtx.clearRect(0, 0, nFreq, nHist);
    linhaImg = foraCtx.createImageData(nFreq, 1);
  }

  function escreveLinha(dados, y) {
    const d = linhaImg.data;
    const esc = 255 / Math.max(1e-9, dbMax - dbMin);
    for (let i = 0; i < nFreq; i++) {
      let k = Math.round((dados[i] - dbMin) * esc);
      if (!isFinite(k)) k = 0;
      k = k < 0 ? 0 : (k > 255 ? 255 : k);
      const o = i * 4, q = k * 4;
      d[o] = lut[q]; d[o + 1] = lut[q + 1]; d[o + 2] = lut[q + 2]; d[o + 3] = 255;
    }
    foraCtx.putImageData(linhaImg, 0, y);
  }

  /* Recolore o histórico inteiro. Só roda quando a escala ou o mapa muda. */
  function recoloreTudo() {
    if (!anel) return;
    for (let y = 0; y < nHist; y++) {
      escreveLinha(anel.subarray(y * nFreq, (y + 1) * nFreq), y);
    }
    pinta();
  }

  function poe(msg) {
    const n = msg.n;
    prepara(n);
    f0 = msg.f_inicio_hz; df = msg.f_passo_hz;
    const v = msg.vetores[0];
    anel.set(v, cabeca * nFreq);
    tempos[cabeca] = msg.t;
    if (MW.q("#escala-esp").value === "auto") autoEscala(v);
    escreveLinha(v, cabeca);
    cabeca = (cabeca + 1) % nHist;
    if (cabeca === 0) cheio = true;
    if (!pendente) { pendente = true; requestAnimationFrame(function () { pendente = false; pinta(); }); }
  }

  /* Percentis 5 e 95, para o mapa não ser dominado por um pico isolado. */
  let autoConta = 0;
  function autoEscala(v) {
    if (autoConta++ % 10) return;
    const bons = Array.prototype.filter.call(v, isFinite).sort(function (a, b) { return a - b; });
    if (bons.length < 10) return;
    const lo = bons[Math.floor(bons.length * 0.05)];
    const hi = bons[Math.floor(bons.length * 0.95)];
    if (hi - lo < 1) return;
    const novoMin = Math.floor(lo - 2), novoMax = Math.ceil(hi + 2);
    if (Math.abs(novoMin - dbMin) > 2 || Math.abs(novoMax - dbMax) > 2) {
      dbMin = novoMin; dbMax = novoMax;
      MW.q("#esp-min").value = dbMin; MW.q("#esp-max").value = dbMax;
      recoloreTudo();
    }
  }

  /* ------------------------------------------------------------ desenho */
  function pinta() {
    if (!vis || !fora) return;
    const W = vis.width, H = vis.height;
    visCtx.imageSmoothingEnabled = false;
    visCtx.clearRect(0, 0, W, H);
    /* Dois desenhos desenrolam o anel: primeiro a parte antiga, depois a
       recente. O mais novo fica embaixo. */
    const velhas = cheio ? nHist - cabeca : 0;
    const novas = cheio ? cabeca : cabeca;
    const total = cheio ? nHist : cabeca;
    if (!total) return;
    const h1 = Math.round(H * velhas / total);
    if (velhas > 0) visCtx.drawImage(fora, 0, cabeca, nFreq, velhas, 0, 0, W, h1);
    if (novas > 0) visCtx.drawImage(fora, 0, 0, nFreq, novas, 0, h1, W, H - h1);
    desenhaEixos();
  }

  function desenhaEixos() {
    if (!eixos) return;
    const W = eixos.width, H = eixos.height;
    const c = eixosCtx;
    c.clearRect(0, 0, W, H);
    c.font = "11px system-ui"; c.fillStyle = MW.cor.tinta2;
    c.strokeStyle = "rgba(255,255,255,.35)"; c.lineWidth = 1;
    for (let k = 0; k <= 5; k++) {
      const x = W * k / 5;
      const f = (f0 + df * (nFreq - 1) * k / 5) / 1e6;
      c.beginPath(); c.moveTo(x, H - 16); c.lineTo(x, H); c.stroke();
      const t = MW.num(f, 0) + " MHz";
      c.fillStyle = "rgba(255,255,255,.9)";
      c.fillText(t, Math.min(W - c.measureText(t).width - 3, Math.max(3, x + 3)), H - 4);
    }
    const total = cheio ? nHist : cabeca;
    if (total > 1) {
      const dur = (tempos[(cabeca - 1 + nHist) % nHist]
        - tempos[cheio ? cabeca : 0]);
      c.fillStyle = "rgba(255,255,255,.9)";
      c.fillText("mais antigo  ·  " + MW.num(dur, 0) + " s de histórico", 6, 14);
      c.fillText("mais recente", 6, H - 22);
    }
  }

  function ajustaTamanho() {
    const host = MW.q("#g-espectrograma");
    if (!host) return;
    const r = host.getBoundingClientRect();
    [vis, eixos].forEach(function (cv) {
      if (!cv) return;
      cv.width = Math.max(100, Math.floor(r.width));
      cv.height = Math.max(100, Math.floor(r.height));
    });
    pinta();
  }

  function inicia() {
    vis = MW.q("#esp-canvas"); visCtx = vis.getContext("2d");
    eixos = MW.q("#esp-eixos"); eixosCtx = eixos.getContext("2d");
    lut = fazLut("casa");
    ajustaTamanho();

    MW.ws.em("linha_espectro", function (m) {
      if (MW.telaAtual !== "espectrograma") return;
      poe(m);
    });

    MW.q("#hist-esp").addEventListener("change", function () {
      nHist = parseInt(this.value, 10);
      nFreq = 0; anel = null; cabeca = 0; cheio = false;
      MW.mensagem("histórico do espectrograma agora é de " + nHist + " linhas");
    });
    MW.q("#mapa-esp").addEventListener("change", function () {
      lut = fazLut(this.value); recoloreTudo();
    });
    MW.q("#escala-esp").addEventListener("change", function () {
      const manual = this.value === "manual";
      MW.q("#esp-min").disabled = !manual;
      MW.q("#esp-max").disabled = !manual;
    });
    let debounce = null;
    ["#esp-min", "#esp-max"].forEach(function (s) {
      MW.q(s).addEventListener("input", function () {
        if (MW.q("#escala-esp").value !== "manual") return;
        dbMin = parseFloat(MW.q("#esp-min").value);
        dbMax = parseFloat(MW.q("#esp-max").value);
        clearTimeout(debounce);
        debounce = setTimeout(recoloreTudo, 100);
      });
    });
    MW.q("#limpa-esp").addEventListener("click", function () {
      nFreq = 0; anel = null; cabeca = 0; cheio = false;
      visCtx.clearRect(0, 0, vis.width, vis.height);
    });

    vis.addEventListener("mousemove", function (ev) {
      if (!anel || !nFreq) return;
      const r = vis.getBoundingClientRect();
      const cx = (ev.clientX - r.left) / r.width;
      const cy = (ev.clientY - r.top) / r.height;
      const i = Math.min(nFreq - 1, Math.max(0, Math.floor(cx * nFreq)));
      const total = cheio ? nHist : cabeca;
      if (!total) return;
      const k = Math.min(total - 1, Math.max(0, Math.floor(cy * total)));
      const y = cheio ? (cabeca + k) % nHist : k;
      const v = anel[y * nFreq + i];
      const idade = tempos[(cabeca - 1 + nHist) % nHist] - tempos[y];
      MW.q("#leitura-esp").innerHTML =
        '<span class="rot">frequência</span><span class="val">' + MW.eng(f0 + df * i) + "</span>" +
        '<span class="rot">valor</span><span class="val">' + MW.num(v, 2) + " dB</span>" +
        '<span class="rot">idade</span><span class="val">' + MW.num(idade, 1) + " s atrás</span>" +
        '<span class="rot">escala</span><span class="val">' + MW.num(dbMin, 0)
        + " a " + MW.num(dbMax, 0) + " dB</span>";
    });

    window.addEventListener("resize", ajustaTamanho);
  }

  return { inicia: inicia, redimensiona: ajustaTamanho };
})();
