"use strict";
/* Tela 4 — curva de calibração do sensor.

   O eixo Y é a grandeza medida; o eixo X é o valor que o operador digita. Cada
   ponto guarda também a covariável, a réplica, a ordem sorteada e a referência
   cruzada, porque sem esses campos o experimento do ROADMAP §F3 não fecha.

   NENHUMA GRANDEZA É FIXA AQUI. O X foi a concentração de um analito e a
   covariável foi a temperatura enquanto existiu um experimento só. Hoje o
   operador digita o nome e a unidade das duas, e todos os rótulos desta tela —
   eixos, cabeçalho da tabela, campos da captura, mensagens — saem daquilo que
   ele digitou. O manual da tela (`js/manual.js`) explica cada termo, e as
   mesmas definições viram a dica de cada campo.

   Dois diagnósticos valem tanto quanto a curva: resíduo contra a ORDEM DE
   EXECUÇÃO e resíduo contra a COVARIÁVEL. É neles que a deriva se revela
   disfarçada de sensibilidade — e é para isso que a ordem é sorteada. */

MW.curva = (function () {
  let pCurva = null, pResid = null, pR2 = null;
  let curvaId = null, dados = { pontos: [] }, ajuste = null, plano = null;
  let inversaLiga = false, ultimoY = null;

  function cria() {
    pCurva = new uPlot({
      width: 600, height: 210,
      /* A escala do Y abre espaço para a BARRA DE ERRO, que é desenhada por
         fora das séries: sem isso a barra do ponto mais alto sai cortada na
         borda, e o operador vê meia incerteza. */
      scales: { x: { time: false },
                y: { range: (u, lo, hi) => MW.faixa(lo, hi,
                       { folga_dado: maiorDesvio() }) } },
      axes: [MW.eixo("X", "auto"), MW.eixo("Y medido", "auto")],
      series: [
        { label: "x", value: (u, v) => MW.num(v, 3) },
        { label: "medido", stroke: MW.cor.cat[0], width: 0,
          points: { show: true, size: 7, stroke: MW.cor.cat[0],
                    fill: MW.cor.cat[0] } },
        MW.serie("ajuste", MW.cor.seq[3], 1.6),
        { label: "leitura ao vivo", stroke: MW.cor.cat[1], width: 0,
          points: { show: true, size: 10, stroke: MW.cor.cat[1] } },
      ],
      hooks: { draw: [barrasDeErro] },
    }, [[0], [null], [null], [null]], MW.q("#g-curva"));

    pResid = new uPlot({
      width: 600, height: 210,
      /* O zero entra na escala à força: é contra a linha do zero que se lê um
         resíduo, e um gráfico sem ela não diz nada. */
      scales: { x: { time: false },
                y: { range: (u, lo, hi) => MW.faixa(lo, hi,
                       { inclui_zero: true, margem: 0.12 }) } },
      axes: [MW.eixo("ordem de execução", "auto"), MW.eixo("resíduo", "auto")],
      series: [
        { label: "eixo", value: (u, v) => MW.num(v, 2) },
        { label: "resíduo", stroke: MW.cor.cat[1], width: 0,
          points: { show: true, size: 7, stroke: MW.cor.cat[1] } },
      ],
      hooks: { draw: [function (u) {
        const y0 = u.valToPos(0, "y", true);
        u.ctx.save(); u.ctx.strokeStyle = MW.cor.grade;
        u.ctx.beginPath(); u.ctx.moveTo(u.bbox.left, y0);
        u.ctx.lineTo(u.bbox.left + u.bbox.width, y0); u.ctx.stroke();
        u.ctx.restore();
      }] },
    }, [[0], [null]], MW.q("#g-residuos"));

    pR2 = new uPlot({
      width: 600, height: 210,
      scales: { x: { time: false } },
      axes: [MW.eixo("Frequência (MHz)", "auto"), MW.eixo("R²", "auto")],
      series: [{ label: "f (MHz)" }, MW.serie("R²", MW.cor.seq[2], 1.4)],
    }, [[0], [null]], MW.q("#g-r2"));
  }

  /* A maior barra de erro em jogo, na escala do gráfico. É o quanto a escala
     do Y precisa abrir além dos pontos para nenhuma barra sair cortada. */
  function maiorDesvio() {
    const e = escala();
    let s = 0;
    dados.pontos.forEach(function (p) {
      if (p.incluido && p.y_desvio) s = Math.max(s, Math.abs(p.y_desvio) / e.k);
    });
    return s;
  }

  /* Barra de erro a partir do desvio das réplicas. */
  function barrasDeErro(u) {
    const pts = dados.pontos.filter(p => p.incluido);
    const c = u.ctx;
    c.save(); c.strokeStyle = MW.cor.cat[0]; c.lineWidth = 1;
    pts.forEach(function (p) {
      if (!p.y_desvio) return;
      const x = u.valToPos(p.x, "x", true);
      const a = u.valToPos(p.y - p.y_desvio, "y", true);
      const b = u.valToPos(p.y + p.y_desvio, "y", true);
      c.beginPath(); c.moveTo(x, a); c.lineTo(x, b);
      c.moveTo(x - 4, a); c.lineTo(x + 4, a);
      c.moveTo(x - 4, b); c.lineTo(x + 4, b); c.stroke();
    });
    c.restore();
  }

  /* --------------------------------------------------------------- dados */
  function carrega() {
    if (!curvaId) return Promise.resolve();
    return MW.api("/api/curva/" + curvaId).then(r => r.json()).then(function (d) {
      dados = d;
      mostraDefinicao();
      rotulos();
      tabela();
      desenha();
    });
  }

  /* A definição da curva: quem é o X e quem é a covariável.
     Ela sai sempre dos CAMPOS da tela, e não da curva carregada, para o rótulo
     acompanhar o que está sendo digitado. O `mostraDefinicao()` é quem mantém
     os campos iguais à curva aberta; antes de existir curva, eles são a
     definição da próxima. */
  function def() {
    return { grandeza_x: MW.q("#curva-grandeza").value.trim() || "X",
             unidade_x: MW.q("#curva-unidade").value.trim(),
             covariavel: MW.q("#curva-cov").value.trim() || "covariável",
             unidade_cov: MW.q("#curva-cov-unidade").value.trim(),
             cov_exigida: MW.q("#curva-cov-exigida").checked };
  }

  /** " (unidade)", ou nada quando a grandeza não tem unidade. */
  function com(u) { return u ? " (" + u + ")" : ""; }

  /* Copia a definição da curva carregada para os campos. Sem isto, trocar de
     curva na lista deixaria na tela o nome da grandeza da curva anterior. */
  function mostraDefinicao() {
    const c = dados.curva;
    if (!c) return;
    MW.q("#curva-grandeza").value = c.grandeza_x || "";
    MW.q("#curva-unidade").value = c.unidade_x || "";
    MW.q("#curva-cov").value = c.covariavel || "";
    MW.q("#curva-cov-unidade").value = c.unidade_cov || "";
    MW.q("#curva-cov-exigida").checked = !!c.cov_exigida;
    if (c.observavel) MW.q("#obs-curva").value = c.observavel;
  }

  /* Todo rótulo da tela sai da definição. Um lugar só faz isso, senão um
     rótulo esquecido continuaria dizendo "temperatura" numa curva de pressão. */
  function rotulos() {
    const d = def();
    MW.q("#rot-cap-x").textContent = d.grandeza_x + com(d.unidade_x);
    MW.q("#rot-cap-cov").textContent = d.covariavel + com(d.unidade_cov);
    MW.q("#cap-cov").placeholder = d.cov_exigida ? "obrigatório" : "opcional";
    MW.q("#col-cov").textContent = d.covariavel + com(d.unidade_cov);
    pCurva.axes[0].label = d.grandeza_x + com(d.unidade_x);
    pResid.axes[0].label = (MW.q("#resid-eixo").value === "cov")
      ? d.covariavel + com(d.unidade_cov) : "ordem de execução";
    /* O uPlot só desenha o rótulo do eixo quando refaz os eixos. */
    pCurva.redraw(false, true);
    pResid.redraw(false, true);
  }

  /* Unidade do eixo Y. Ela é conhecida assim que o observável é escolhido —
     não depende de já haver ajuste, senão os primeiros pontos apareceriam em
     hertz cru e ninguém leria 1.538.890.107,65. */
  function unidadeY() {
    if (ajuste && ajuste.unidade_y) return ajuste.unidade_y;
    const v = (dados.curva && dados.curva.observavel)
      || MW.q("#obs-curva").value || "";
    const [tipo, nome] = v.split(":");
    if (tipo === "derivado") return (MW.estado.unidade_escalar || {})[nome] || "";
    const o = (MW.estado.observaveis || []).find(x => x.id === nome);
    return o ? o.unidade : "";
  }

  function escala() {
    const u = unidadeY();
    return u === "Hz" ? { k: 1e6, u: "MHz" } : { k: 1, u: u || "" };
  }

  function desenha() {
    const pts = dados.pontos.filter(p => p.incluido);
    const e = escala();
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y / e.k);
    let linha = null, xs2 = xs;
    if (ajuste && !ajuste.erro && xs.length) {
      const lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
      xs2 = []; linha = [];
      for (let i = 0; i <= 60; i++) {
        const x = lo + (hi - lo) * i / 60;
        xs2.push(x);
        linha.push(prev(x) / e.k);
      }
    }
    /* Junta as duas grades de X num eixo só. */
    const todos = Array.from(new Set(xs.concat(xs2))).sort((a, b) => a - b);
    const mapa = function (gx, gy) {
      const m = new Map(); gx.forEach((v, i) => m.set(v, gy[i]));
      return todos.map(v => (m.has(v) ? m.get(v) : null));
    };
    pCurva.axes[1].label = "Y medido" + (e.u ? " (" + e.u + ")" : "");
    pCurva.setData([todos, mapa(xs, ys),
                    linha ? mapa(xs2, linha) : MW.vazio(todos.length),
                    MW.vazio(todos.length)]);

    desenhaResiduos();
  }

  /* O resíduo contra a ordem de execução mostra deriva no tempo; contra a
     covariável, mostra que ela importa. São perguntas diferentes, e por isso o
     eixo é uma escolha, não um segundo gráfico. */
  function desenhaResiduos() {
    if (!ajuste || ajuste.erro) return;
    const e = escala();
    const res = ajuste.residuos.map(v => v / e.k);
    const porCov = MW.q("#resid-eixo").value === "cov";
    const eixo = (porCov ? ajuste.cov_pontos : ajuste.ordem)
      || res.map((v, i) => i + 1);
    /* O uPlot exige X crescente, e a covariável não vem em ordem nenhuma. */
    const pares = res.map((v, i) => [eixo[i], v])
      .filter(p => p[0] !== null && p[0] !== undefined && isFinite(p[0]))
      .sort((a, b) => a[0] - b[0]);
    if (!pares.length) {
      pResid.setData([[0], [null]]);
      return;
    }
    pResid.setData([pares.map(p => p[0]), pares.map(p => p[1])]);
  }

  function prev(x) {
    const c = ajuste.coefs;
    if (ajuste.tipo === "covariavel") return c[0] + c[1] * x;
    let v = 0;
    for (let i = 0; i < c.length; i++) v = v * x + c[i];
    return v;
  }

  function tabela() {
    const tb = MW.q("#tabela-pontos tbody");
    tb.innerHTML = "";
    const e = escala();
    dados.pontos.forEach(function (p) {
      const tr = document.createElement("tr");
      if (!p.incluido) tr.className = "fora";
      tr.innerHTML =
        '<td><input type="checkbox" ' + (p.incluido ? "checked" : "") + "></td>" +
        "<td>" + MW.num(p.x, 3) + "</td>" +
        "<td>" + MW.num(p.y / e.k, 4) + "</td>" +
        "<td>" + MW.num((p.y_desvio || 0) / e.k, 5) + "</td>" +
        "<td>" + p.n_med + "</td>" +
        "<td>" + MW.num(p.cov, 2) + "</td>" +
        "<td>" + (p.replica || "") + "</td>" +
        "<td>" + (p.ordem_sorteada || "") + "</td>" +
        "<td>" + new Date(p.t * 1000).toLocaleTimeString("pt-BR") + "</td>" +
        '<td><button class="apagar">apagar</button></td>';
      tr.querySelector("input").addEventListener("change", function () {
        /* Ponto fora nunca é apagado por acidente: ele é EXCLUÍDO, e
           continua no banco. É o que separa um caderno de laboratório de
           um retoque. */
        MW.api("/api/ponto", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: p.id, incluido: this.checked }) })
          .then(carrega);
      });
      tr.querySelector(".apagar").addEventListener("click", function () {
        if (!confirm("Apagar este ponto de vez?")) return;
        MW.api("/api/ponto", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: p.id, apagar: true }) }).then(carrega);
      });
      tb.appendChild(tr);
    });
  }

  /* ------------------------------------------------------------- ações */
  /** A definição que está nos campos, no formato que a rota espera. */
  function corpoDefinicao() {
    return {
      grandeza_x: MW.q("#curva-grandeza").value.trim(),
      unidade_x: MW.q("#curva-unidade").value.trim(),
      covariavel: MW.q("#curva-cov").value.trim(),
      unidade_cov: MW.q("#curva-cov-unidade").value.trim(),
      cov_exigida: MW.q("#curva-cov-exigida").checked,
    };
  }

  function novaCurva() {
    const corpo = corpoDefinicao();
    corpo.observavel = MW.q("#obs-curva").value;
    return MW.api("/api/curva", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo) })
      .then(r => r.json()).then(function (d) {
        dados = { pontos: [] }; ajuste = null;
        MW.q("#curva-numeros").innerHTML = "";
        MW.mensagem("curva " + d.id + " criada");
        return listaCurvas(d.id);
      });
  }

  /* Editar a definição vale para a curva aberta. Renomear a grandeza não
     mexe em nenhum número medido — só troca o rótulo — e é melhor do que
     deixar o operador olhando um campo que não obedece. */
  function salvaDefinicao() {
    if (!curvaId) { rotulos(); return Promise.resolve(); }
    return MW.api("/api/curva/" + curvaId + "/definicao", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpoDefinicao()) })
      .then(() => carrega());
  }

  function captura() {
    const d = def();
    const t = MW.q("#cap-cov").value;
    if (t === "" && d.cov_exigida) {
      alert("Falta o valor de " + d.covariavel + ".\n\nA curva exige a "
        + "covariável em todo ponto: sem ela o ponto não entra no ajuste com "
        + "covariável, e a deriva não pode ser descontada depois.\n\nDesligue "
        + "a exigência na definição da curva se ela não importar aqui.");
      MW.q("#cap-cov").focus();
      return;
    }
    const x = MW.q("#cap-x").value;
    if (x === "") { alert("Informe o valor de " + d.grandeza_x + "."); return; }
    const seguir = function () {
      MW.ws.manda({
        t: "capturar", curva_id: curvaId, obs: MW.q("#obs-curva").value,
        x: parseFloat(x), cov: t === "" ? null : parseFloat(t),
        replica: MW.q("#cap-rep").value,
        ordem: MW.q("#cap-ordem").value ? parseInt(MW.q("#cap-ordem").value, 10) : null,
        x_ref: MW.q("#cap-ref").value ? parseFloat(MW.q("#cap-ref").value) : null,
        n_med: parseInt(MW.q("#cap-n").value, 10),
        nota: MW.q("#cap-nota").value,
      });
      MW.q("#cap-botao").disabled = true;
    };
    if (!curvaId) novaCurva().then(seguir); else seguir();
  }

  function ajustar() {
    if (!curvaId) return;
    const corpo = {
      tipo: MW.q("#tipo-ajuste").value,
      faixa_lo: MW.q("#faixa-lo").value ? parseFloat(MW.q("#faixa-lo").value) : null,
      faixa_hi: MW.q("#faixa-hi").value ? parseFloat(MW.q("#faixa-hi").value) : null,
      sigma_origem: MW.q("#sigma-origem").value,
      sigma_y: MW.q("#sigma-origem").value === "assumida"
        ? parseFloat(MW.q("#sigma-valor").value) : null,
    };
    MW.api("/api/curva/" + curvaId + "/ajustar", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo) })
      .then(r => r.json()).then(function (a) {
        ajuste = a;
        numeros(a);
        desenha();
      });
  }

  function numeros(a) {
    const el = MW.q("#curva-numeros");
    if (a.erro) { el.innerHTML = '<span class="mau">' + a.erro + "</span>"; return; }
    const d = def();
    const ux = d.unidade_x;
    const rot = (termo, texto) => '<span class="rot" data-termo="' + termo
      + '">' + texto + "</span>";
    let h = "<div>" + a.resumo.split("\n").join("</div><div>") + "</div>";
    h += "<div>" + rot("r2-ajustado", "R² ajustado")
      + '<span class="val">' + MW.num(a.r2_aj, 4) + "</span>"
      + rot("s-yx", "erro padrão do ajuste")
      + '<span class="val">' + MW.num(a.s_yx, 5) + "</span>"
      + rot("loq", "LOQ")
      + '<span class="val">' + MW.num(a.loq, 3) + " " + ux + "</span></div>";
    if (a.tipo === "covariavel") {
      /* Quanto de X uma unidade da covariável imita. É este número, e não o
         coeficiente cru, que diz se a covariável precisa ser controlada. */
      const porUnidade = a.coef_cov / a.sensibilidade;
      const uc = d.unidade_cov;
      h += "<div>" + rot("coef-cov", "coeficiente de " + d.covariavel)
        + '<span class="val">' + MW.num(a.coef_cov, 4)
        + (uc ? " por " + uc : " por unidade") + "</span>"
        + rot("coef-cov", (uc ? "um " + uc : "uma unidade") + " imita")
        + '<span class="val">' + MW.num(Math.abs(porUnidade), 4) + " " + ux
        + "</span>"
        + rot("cov-ref", d.covariavel + " de referência")
        + '<span class="val">' + MW.num(a.cov_ref, 2) + " " + uc + "</span></div>";
    }
    el.innerHTML = h;
    MW.manual.aplicaDicas(el);
  }

  function planejar() {
    const x0 = parseFloat(prompt("X mínimo:", "0"));
    const x1 = parseFloat(prompt("X máximo:", "10"));
    const dx = parseFloat(prompt("Passo:", "1"));
    const nr = parseInt(prompt("Réplicas:", "1"), 10);
    const ref = prompt("Nível de referência intercalado (vazio = nenhum):", "0");
    MW.api("/api/planejar", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x_min: x0, x_max: x1, passo: dx, replicas: nr,
        referencia: ref === "" ? null : parseFloat(ref) }) })
      .then(r => r.json()).then(function (p) {
        plano = p; p.i = 0;
        MW.mensagem("série sorteada: " + p.n + " pontos, semente " + p.semente);
        proximoDoPlano();
      });
  }

  function proximoDoPlano() {
    if (!plano || plano.i >= plano.itens.length) {
      if (plano) MW.mensagem("série concluída");
      plano = null; return;
    }
    const it = plano.itens[plano.i];
    MW.q("#cap-x").value = it.x;
    MW.q("#cap-rep").value = it.replica;
    MW.q("#cap-ordem").value = it.ordem_sorteada;
    MW.q("#cap-estado").textContent =
      "plano: ponto " + (plano.i + 1) + " de " + plano.itens.length
      + " — prepare X = " + MW.num(it.x, 3) + " (réplica " + it.replica + ")";
  }

  function listaCurvas(escolher) {
    return MW.api("/api/curvas").then(r => r.json()).then(function (d) {
      const el = MW.q("#curva-lista");
      el.innerHTML = "";
      d.curvas.forEach(function (c) {
        const o = document.createElement("option");
        o.value = c.id;
        o.textContent = c.nome + " — " + (c.grandeza_x || "X")
          + " (" + c.n_pontos + " pts)";
        el.appendChild(o);
      });
      const alvo = escolher || d.atual || (d.curvas[0] && d.curvas[0].id);
      if (alvo) { el.value = String(alvo); curvaId = parseInt(alvo, 10); }
      return carrega();
    });
  }

  function inicia() {
    cria();
    /* O manual e as dicas saem do mesmo texto, no `js/manual.js`. */
    MW.manual.monta(MW.q("#manual-corpo"));
    MW.manual.aplicaDicas(MW.q("#tela-curva"));
    rotulos();
    listaCurvas();
    MW.q("#curva-lista").addEventListener("change", function () {
      curvaId = parseInt(this.value, 10);
      ajuste = null;
      MW.q("#curva-numeros").innerHTML = "";
      carrega();
    });

    MW.ws.em("captura", function (m) {
      if (m.estado === "andando") {
        MW.q("#cap-estado").textContent = "medindo… faltam " + m.faltam;
      } else if (m.estado === "falhou") {
        MW.q("#cap-estado").textContent = "captura falhou: " + m.msg;
        MW.q("#cap-botao").disabled = false;
      }
    });

    MW.ws.em("ponto", function (m) {
      MW.q("#cap-botao").disabled = false;
      const e = escala();
      MW.q("#cap-estado").textContent =
        "ponto gravado: Y = " + MW.num(m.y / e.k, 4) + " ± "
        + MW.num(m.y_desvio / e.k, 5) + " " + e.u + " (n = " + m.n_med
        + (m.recusas ? ", " + m.recusas + " recusas" : "") + ")";
      if (plano) { plano.i++; proximoDoPlano(); }
      carrega().then(function () { if (ajuste) ajustar(); });
      const el = MW.q("#curva-lista").selectedOptions[0];
      if (el) el.textContent = el.textContent.replace(/\(\d+ pts\)/,
        "(" + (dados.pontos.length + 1) + " pts)");
    });

    MW.ws.em("escalar", function (m) {
      if (!inversaLiga || !m.ok || !m.valores) return;
      const alvo = MW.q("#obs-curva").value.split(":")[1];
      ultimoY = m.valores[alvo];
      if (ultimoY === undefined || !curvaId || !ajuste || ajuste.erro) return;
      const c = MW.q("#cap-cov").value;
      MW.api("/api/curva/" + curvaId + "/inversa", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ y: ultimoY, m: 1,
          tipo: MW.q("#tipo-ajuste").value,
          cov: c === "" ? null : parseFloat(c) }) })
        .then(r => r.json()).then(function (r) {
          const el = MW.q("#inversa-saida");
          const ux = def().unidade_x;
          el.innerHTML = r.erro
            ? '<span class="mau">' + r.erro + "</span>"
            : (MW.num(r.x, 3) + " ± " + MW.num(r.meia_largura, 3) + " " + ux
               + " (" + Math.round(r.confianca * 100) + " %)");
        });
    });

    MW.q("#curva-nova").addEventListener("click", novaCurva);
    MW.q("#cap-botao").addEventListener("click", captura);
    MW.q("#curva-ajustar").addEventListener("click", ajustar);
    MW.q("#curva-planejar").addEventListener("click", planejar);

    /* Definição da curva: o que o operador digita vira rótulo na hora, e vai
       para a curva aberta quando ele sai do campo. */
    ["#curva-grandeza", "#curva-unidade", "#curva-cov",
     "#curva-cov-unidade"].forEach(function (sel) {
      MW.q(sel).addEventListener("input", rotulos);
      MW.q(sel).addEventListener("change", salvaDefinicao);
    });
    MW.q("#curva-cov-exigida").addEventListener("change", salvaDefinicao);
    MW.q("#obs-curva").addEventListener("change", function () {
      rotulos(); desenha();
    });
    MW.q("#resid-eixo").addEventListener("change", function () {
      rotulos(); desenhaResiduos();
    });
    MW.q("#curva-manual").addEventListener("click", function () {
      const m = MW.q("#manual-curva");
      m.open = !m.open;
      if (m.open) m.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    MW.q("#inversa-liga").addEventListener("change", function () {
      inversaLiga = this.checked;
      if (!inversaLiga) MW.q("#inversa-saida").textContent = "";
    });
    MW.q("#sigma-origem").addEventListener("change", function () {
      MW.q("#sigma-valor").disabled = this.value !== "assumida";
    });
    MW.q("#curva-csv").addEventListener("click", function () {
      if (!curvaId) return;
      /* Baixa em vez de abrir numa aba: no modo local não existe URL para
         abrir, e um CSV numa aba do navegador não serve para nada mesmo. */
      MW.api("/api/curva/" + curvaId + "/csv").then(r => r.text())
        .then(function (txt) {
          MW.baixa("curva_" + curvaId + ".csv", txt, "text/csv;charset=utf-8");
        });
    });
    MW.q("#curva-r2").addEventListener("click", function () {
      if (!curvaId) return;
      MW.mensagem("varrendo R² frequência a frequência…");
      MW.api("/api/curva/" + curvaId + "/r2").then(r => r.json()).then(function (d) {
        if (d.erro) { MW.mensagem(d.erro); return; }
        pR2.setData([d.freqs.map(v => v / 1e6), d.r2]);
        MW.mensagem("melhor R² = " + MW.num(d.melhor_r2, 4) + " em "
          + MW.eng(d.melhor_hz) + " (inclinação "
          + MW.num(d.melhor_inclinacao, 4) + " dB por unidade)");
      });
    });
    MW.q("#curva-figura").addEventListener("click", function () {
      MW.mensagem("a figura para artigo sai do matplotlib, no estilo da casa — "
        + "use o exportador da sessão");
    });

    window.addEventListener("resize", redimensiona);
  }

  function redimensiona() {
    MW.ajusta(pCurva, MW.q("#g-curva"));
    MW.ajusta(pResid, MW.q("#g-residuos"));
    MW.ajusta(pR2, MW.q("#g-r2"));
  }

  return { inicia: inicia, redimensiona: redimensiona };
})();
