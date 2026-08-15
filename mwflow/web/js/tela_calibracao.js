"use strict";
/* Tela 5 — calibração SOLT e o colchete da sessão.

   A calibração é guiada: um cartão por padrão, medido com muitas repetições.
   Os padrões são medidos SEM correção — o servidor garante isso.

   O colchete existe porque uma série gravimétrica leva horas e o aparelho
   deriva com a temperatura. Uma calibração só no começo não separa a deriva do
   instrumento da deriva do sensor. */

MW.calibracao = (function () {
  let medidos = [], calAplicada = null, calInicial = null, calFinal = null;

  function marca() {
    MW.qq(".passo").forEach(function (el) {
      const p = el.dataset.padrao;
      const feito = medidos.indexOf(p) >= 0;
      el.classList.toggle("feito", feito);
      el.querySelector(".marca").textContent = feito ? "medido" : "";
    });
    const falta = ["aberto", "curto", "carga"].filter(p => medidos.indexOf(p) < 0);
    MW.q("#cal-resolver").disabled = falta.length > 0;
    MW.q("#cal-estado").textContent = falta.length
      ? "faltam: " + falta.join(", ")
      : (medidos.indexOf("thru") >= 0
         ? "pronto para resolver, com transmissão"
         : "pronto para resolver, só reflexão (S11)");
  }

  function aviso(txt) {
    const el = MW.q("#cal-aviso");
    el.classList.toggle("oculto", !txt);
    el.innerHTML = txt || "";
  }

  function listaCals() {
    MW.api("/api/kits").then(r => r.json()).then(function (d) {
      const k = MW.q("#cal-kit");
      k.innerHTML = "";
      d.kits.forEach(function (n) {
        const o = document.createElement("option");
        o.value = n; o.textContent = n;
        k.appendChild(o);
      });
      k.value = d.kits.indexOf("sma_generico") >= 0 ? "sma_generico" : d.kits[0];

      const l = MW.q("#cal-lista");
      l.innerHTML = "";
      d.cals.forEach(function (n) {
        const o = document.createElement("option");
        o.value = n; o.textContent = n;
        l.appendChild(o);
      });
    });
  }

  function resolver() {
    MW.api("/api/cal/resolver", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kit: MW.q("#cal-kit").value,
        nome: MW.q("#cal-nome").value || null,
        n_medias: parseInt(MW.q("#cal-medias").value, 10) }) })
      .then(r => r.json()).then(function (d) {
        if (d.erro) { aviso(d.erro); return; }
        aviso(d.aviso ? "<strong>Atenção:</strong> " + d.aviso : "");
        MW.q("#cal-numeros").innerHTML =
          '<span class="rot">conjunto</span><span class="val">' + d.nome + "</span>" +
          '<span class="rot">tipo</span><span class="val">' + d.tipo + "</span>" +
          '<span class="rot">banda</span><span class="val">'
            + MW.eng(d.f_inicio_hz) + " a " + MW.eng(d.f_fim_hz) + "</span>" +
          '<span class="rot">pontos</span><span class="val">' + d.n + "</span>" +
          '<span class="rot">condição máxima</span><span class="val'
            + (d.cond_max > 1e6 ? " mau" : "") + '">' + MW.num(d.cond_max, 1) + "</span>";
        if (!calInicial) calInicial = d.nome; else calFinal = d.nome;
        listaCals();
        aplicar(d.nome);
      });
  }

  function aplicar(nome) {
    const modo = MW.q("#cal-modo").value;
    MW.api("/api/cal/aplicar", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nome || MW.q("#cal-lista").value,
        nome_fim: calFinal, modo: modo }) })
      .then(r => r.json()).then(function (d) {
        calAplicada = d.nome || null;
        if (d.aviso) aviso("<strong>Atenção:</strong> " + d.aviso);
        MW.mensagem(d.estado === "aplicada"
          ? "calibração " + d.nome + " aplicada (modo " + d.modo + ")"
          : "medindo sem calibração");
      });
  }

  function reverificar() {
    const falta = ["aberto", "curto", "carga"].filter(p => medidos.indexOf(p) < 0);
    if (falta.length) {
      aviso("Para reverificar, meça de novo: " + falta.join(", ")
        + ". Use os mesmos padrões da calibração inicial.");
      return;
    }
    MW.api("/api/cal/reverificar", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}) })
      .then(r => r.json()).then(function (r) {
        if (r.erro) { aviso(r.erro); return; }
        const ok = r.veredito === "aprovado";
        MW.q("#cal-numeros").innerHTML =
          '<div><span class="rot">reverificação de</span><span class="val">' + r.cal + "</span>" +
          '<span class="rot">carga corrigida</span><span class="val' + (ok ? "" : " mau") + '">'
            + MW.num(r.carga.pior_db, 1) + " dB (pior)</span>" +
          '<span class="rot">aberto</span><span class="val">'
            + MW.num(r.aberto.pior_fase_graus, 2) + "° de erro</span>" +
          '<span class="rot">curto</span><span class="val">'
            + MW.num(r.curto.pior_fase_graus, 2) + "° de erro</span>" +
          '<span class="rot">veredito</span><span class="val' + (ok ? "" : " mau") + '">'
            + r.veredito + "</span></div>";
        aviso(ok ? "" : "<strong>Sessão reprovada na reverificação.</strong> "
          + "A carga corrigida ficou acima de −30 dB. O instrumento andou "
          + "demais durante a sessão, ou um padrão está sujo ou mal rosqueado. "
          + "Os dados brutos continuam gravados; considere refazer a "
          + "calibração e reprocessar no modo interpolado.");
      });
  }

  function inicia() {
    listaCals();
    marca();
    MW.q("#cal-resolver").disabled = true;

    MW.ws.em("cal", function (m) {
      if (m.estado === "andando") {
        MW.q("#cal-estado").textContent =
          "medindo " + m.padrao + "… faltam " + m.faltam;
      } else if (m.estado === "medido") {
        medidos = m.padroes || [];
        marca();
        MW.mensagem("padrão " + m.padrao + " medido (" + m.n_medias + " repetições)");
      } else if (m.estado === "medidas") {
        medidos = m.padroes || [];
        marca();
      }
    });

    MW.ws.em("estado", function (m) {
      if (m.cal_padroes) { medidos = m.cal_padroes; marca(); }
      if (m.cal_nome) calAplicada = m.cal_nome;
    });

    MW.qq(".passo button").forEach(function (b) {
      b.addEventListener("click", function () {
        const padrao = b.closest(".passo").dataset.padrao;
        MW.ws.manda({ t: "cal_medir", padrao: padrao,
          n_medias: parseInt(MW.q("#cal-medias").value, 10) });
        MW.q("#cal-estado").textContent = "medindo " + padrao + "…";
      });
    });

    MW.q("#cal-resolver").addEventListener("click", resolver);
    MW.q("#cal-aplicar").addEventListener("click", function () { aplicar(null); });
    MW.q("#cal-remover").addEventListener("click", function () {
      MW.api("/api/cal/aplicar", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: null }) })
        .then(function () { MW.mensagem("medindo sem calibração"); });
    });
    MW.q("#cal-reverificar").addEventListener("click", reverificar);
    MW.q("#cal-segunda").addEventListener("click", function () {
      medidos = [];
      ["aberto", "curto", "carga", "thru", "isolamento"].forEach(function (p) {
        MW.ws.manda({ t: "cal_esquecer", padrao: p });
      });
      marca();
      MW.q("#cal-nome").value = (calInicial || "cal") + "_fim";
      aviso("Meça os padrões de novo e resolva. O conjunto do fim entra como "
        + "segundo termo do colchete: com ele, o modo <strong>interpolado</strong> "
        + "corrige a deriva ao longo da sessão em vez de apenas medi-la. "
        + "A interpolação supõe deriva lenta e monótona — se alguém mexeu nos "
        + "cabos, use o modo <strong>inicial</strong>.");
    });
    MW.q("#cal-modo").addEventListener("change", function () {
      if (this.value !== "inicial" && !calFinal) {
        aviso("Este modo precisa de uma segunda calibração. Meça os padrões de "
          + "novo com o botão de segunda calibração.");
        this.value = "inicial";
        return;
      }
      aplicar(calInicial);
    });
  }

  return { inicia: inicia, redimensiona: function () {} };
})();
