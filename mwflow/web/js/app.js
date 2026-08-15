"use strict";
/* Costura: abas, painel do aparelho e estado global. */

MW.estado = { config: {}, param: "s21", banda_hz: [1.3e9, 2.0e9], modo: "parado",
              observaveis: [], unidade_escalar: {}, rotulo_escalar: {} };

/* Tópicos por tela: a tela escondida não recebe nada. Um espectrograma que
   ninguém está vendo não deve custar banda nem processamento. */
const BASE = ["estado", "erro", "mensagem"];
const TOPICOS = {
  varredura:     BASE.concat(["escalar", "varredura"]),
  osciloscopio:  BASE.concat(["escalar", "amostras_cw"]),
  espectrograma: BASE.concat(["linha_espectro"]),
  curva:         BASE.concat(["escalar", "ponto", "captura", "curva"]),
  calibracao:    BASE.concat(["escalar", "cal", "captura"]),
};

MW.telaAtual = "varredura";

/* Campos do painel que o estado do aparelho reescreve. O motor difunde o
   estado de segundo em segundo; sem esta lista ele apaga o que o usuário
   está digitando antes de ele chegar no botão Aplicar. */
const CAMPOS_PAINEL = ["#modo", "#f-inicio", "#f-fim", "#pontos", "#f-cw",
                       "#param", "#banda-lo", "#banda-hi"];

/* Um campo fica SUJO quando o usuário o edita, e limpo quando o aparelho
   confirma a nova configuração — isto é, quando a geração sobe. Enquanto
   sujo, o estado não o sobrescreve. */
const sujos = new Set();
let pedido = null;          // {geracao, t} da última configuração enviada

function marcaSujo(sel) {
  sujos.add(sel);
  MW.q(sel).classList.add("sujo");
  MW.q("#aplicar").disabled = false;
}

function limpaSujos() {
  CAMPOS_PAINEL.forEach(function (s) { MW.q(s).classList.remove("sujo"); });
  sujos.clear();
}

function poe(sel, valor) {
  if (sujos.has(sel)) return;
  MW.q(sel).value = valor;
}

function trocaTela(nome) {
  MW.telaAtual = nome;
  MW.qq("#abas button").forEach(function (b) {
    b.classList.toggle("ativa", b.dataset.tela === nome);
  });
  MW.qq(".tela").forEach(function (s) {
    s.classList.toggle("ativa", s.id === "tela-" + nome);
  });
  MW.ws.assina(TOPICOS[nome] || TOPICOS.varredura);
  setTimeout(function () {
    if (MW.varredura) MW.varredura.redimensiona();
    if (MW.osciloscopio) MW.osciloscopio.redimensiona();
    if (MW.espectrograma) MW.espectrograma.redimensiona();
    if (MW.curva) MW.curva.redimensiona();
  }, 30);
}

function aplicaPainel() {
  const modo = MW.q("#modo").value;
  MW.ws.manda({
    t: "configurar",
    f_inicio_hz: parseFloat(MW.q("#f-inicio").value) * 1e6,
    f_fim_hz: parseFloat(MW.q("#f-fim").value) * 1e6,
    n_pontos: parseInt(MW.q("#pontos").value, 10),
    vpf: parseInt(MW.q("#vpf").value, 10),
    medias: parseInt(MW.q("#medias").value, 10),
  });
  MW.ws.manda({
    t: "modo", modo: modo,
    f_cw_hz: parseFloat(MW.q("#f-cw").value) * 1e6,
    banda_hz: [parseFloat(MW.q("#banda-lo").value) * 1e6,
               parseFloat(MW.q("#banda-hi").value) * 1e6],
  });
  MW.ws.manda({
    t: "observavel", param: MW.q("#param").value,
    banda_hz: [parseFloat(MW.q("#banda-lo").value) * 1e6,
               parseFloat(MW.q("#banda-hi").value) * 1e6],
  });
  MW.q("#aplicar").disabled = true;
  pedido = { geracao: MW.estado.geracao || 0, t: Date.now() };
  MW.mensagem("configuração enviada; esperando o aparelho confirmar");
}

function mostraEstado(m) {
  MW.estado = Object.assign(MW.estado, m);
  const a = MW.q("#selo-aparelho");
  if (m.aparelho === "simulado") {
    a.textContent = "SIMULADO";
    a.className = "selo simulado";
  } else if (m.aparelho === "litevna") {
    a.textContent = "LiteVNA64 fw " + (m.identidade.firmware || "?");
    a.className = "selo ok";
  } else {
    a.textContent = "sem aparelho";
    a.className = "selo mau";
  }

  const c = MW.q("#selo-cal");
  c.textContent = m.cal === "aplicada" ? "calibrado" : "sem cal";
  c.className = "selo " + (m.cal === "aplicada" ? "ok" : "");

  const t = MW.q("#selo-taxa");
  if (m.modo === "cw") {
    t.textContent = MW.num(m.taxa_pontos_s, 0) + " amostras/s";
  } else if (m.taxa_varreduras_s) {
    t.textContent = MW.num(m.taxa_varreduras_s, 2) + " varr./s  ·  "
      + MW.num(m.taxa_pontos_s, 0) + " pontos/s";
  } else {
    t.textContent = m.modo;
  }

  /* A configuração pedida já foi para o aparelho: ele subiu a geração. Os
     campos voltam a seguir o estado. Se em 5 s a geração não subir, solta os
     campos assim mesmo e diz que o pedido não passou. */
  if (pedido && m.geracao > pedido.geracao) {
    pedido = null;
    limpaSujos();
  } else if (pedido && Date.now() - pedido.t > 5000) {
    pedido = null;
    limpaSujos();
    MW.mensagem("o aparelho não confirmou a configuração; o painel voltou "
                + "para o que vale agora");
  }

  /* O painel só mostra o que o aparelho confirmou. Nunca mostrar uma
     configuração pedida como se já valesse — mas nunca apagar, também, o
     campo que o usuário ainda está editando. */
  const cf = m.config || {};
  poe("#f-inicio", (cf.f_inicio_hz / 1e6).toFixed(3));
  poe("#f-fim", (cf.f_fim_hz / 1e6).toFixed(3));
  poe("#f-cw", (cf.f_cw_hz / 1e6).toFixed(3));
  poe("#modo", m.modo === "parado" ? "parado" : m.modo);
  poe("#param", m.param);
  poe("#banda-lo", (m.banda_hz[0] / 1e6).toFixed(1));
  poe("#banda-hi", (m.banda_hz[1] / 1e6).toFixed(1));
  if (!pedido) MW.q("#aplicar").disabled = false;

  if (m.pontos_max) {
    MW.qq("#pontos option").forEach(function (o) {
      o.disabled = parseInt(o.value || o.textContent, 10) > m.pontos_max;
    });
  }
  poe("#pontos", String(cf.n_pontos));

  const gv = MW.q("#grupo-varredura"), gc = MW.q("#grupo-cw");
  gv.style.opacity = m.modo === "cw" ? .45 : 1;
  gc.style.opacity = m.modo === "cw" ? 1 : .45;

  if (m.erro) MW.mensagem("aparelho: " + m.erro);
  if (m.quedas) {
    const q = Object.keys(m.quedas)
      .filter(function (k) { return m.quedas[k] > 0; })
      .map(function (k) { return k + ": " + m.quedas[k]; }).join("  ·  ");
    MW.q("#quedas").textContent = q ? "quadros descartados — " + q : "";
  }
}

function preencheObservaveis(dados) {
  MW.estado.observaveis = dados.observaveis;
  MW.estado.unidade_escalar = dados.unidade_escalar;
  MW.estado.rotulo_escalar = dados.rotulo_escalar;

  /* Os menus de grandeza saem do registro do servidor. Acrescentar um
     observável em Python não pede nenhuma mudança aqui. */
  const opcoes = [];
  dados.observaveis.forEach(function (o) {
    if (o.tipo === "traco") {
      opcoes.push({ v: "traco:" + o.id, r: o.rotulo, tipo: "traco" });
    } else {
      o.saidas.forEach(function (s) {
        opcoes.push({ v: "derivado:" + s,
                      r: (dados.rotulo_escalar[s] || s)
                         + (dados.unidade_escalar[s] ? " (" + dados.unidade_escalar[s] + ")" : ""),
                      tipo: "derivado" });
      });
    }
  });
  ["#obs-osc", "#obs-curva"].forEach(function (sel) {
    const el = MW.q(sel);
    if (!el) return;
    /* O catálogo chega depois de a curva ser carregada. Sem guardar a escolha,
       o menu voltaria para f_res e a tela mostraria uma grandeza que não é a
       da curva aberta. */
    const antes = el.value;
    el.innerHTML = "";
    opcoes.forEach(function (o) {
      const op = document.createElement("option");
      op.value = o.v; op.textContent = o.r; op.dataset.tipo = o.tipo;
      el.appendChild(op);
    });
    el.value = opcoes.some(function (o) { return o.v === antes; })
      ? antes : "derivado:f_res";
  });
}

document.addEventListener("DOMContentLoaded", function () {
  MW.qq("#abas button").forEach(function (b) {
    b.addEventListener("click", function () { trocaTela(b.dataset.tela); });
  });
  MW.q("#aplicar").addEventListener("click", aplicaPainel);

  CAMPOS_PAINEL.forEach(function (sel) {
    const el = MW.q(sel);
    ["input", "change"].forEach(function (ev) {
      el.addEventListener(ev, function () { marcaSujo(sel); });
    });
  });

  /* Enter num campo do painel aplica; Escape desiste e devolve o valor do
     aparelho na próxima difusão de estado. */
  CAMPOS_PAINEL.forEach(function (sel) {
    MW.q(sel).addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); aplicaPainel(); }
      if (e.key === "Escape") { limpaSujos(); }
    });
  });

  /* Trocar o modo aplica na hora: sem ele o aparelho não sabe o que fazer. */
  MW.q("#modo").addEventListener("change", aplicaPainel);

  MW.varredura.inicia();
  MW.osciloscopio.inicia();
  MW.espectrograma.inicia();
  MW.curva.inicia();
  MW.calibracao.inicia();

  MW.ws.em("estado", mostraEstado);
  MW.ws.em("erro", function (m) { MW.mensagem("erro — " + m.msg); });
  MW.ws.em("_ligado", function () { trocaTela(MW.telaAtual); });

  MW.api("/api/observaveis").then(r => r.json()).then(preencheObservaveis);
  MW.ws.conecta();
  setInterval(function () { MW.ws.manda({ t: "quedas" }); }, 3000);
});
