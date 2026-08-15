"use strict";
/* Cliente do WebSocket: reconexão, decodificação binária e despacho por tópico.

   Quadro binário:
     [uint32 pouco-significativo: tamanho do cabeçalho]
     [cabeçalho JSON em UTF-8, múltiplo de 4]
     [carga em float32]

   O cabeçalho traz `campos`: "c" para um vetor complexo (dois blocos, real e
   imaginário) e "r" para um vetor real (um bloco). O tamanho de cada bloco é
   `n`, também do cabeçalho. */

MW.ws = (function () {
  let sock = null;
  let tentativa = 0;
  const ouvintes = {};
  const dec = new TextDecoder("utf-8");

  function em(tipo, fn) {
    (ouvintes[tipo] = ouvintes[tipo] || []).push(fn);
  }

  function despacha(msg) {
    const l = ouvintes[msg.tipo];
    if (l) l.forEach(function (f) { try { f(msg); } catch (e) { console.error(e); } });
  }

  function decodifica(buf) {
    const dv = new DataView(buf);
    const nCab = dv.getUint32(0, true);
    const msg = JSON.parse(dec.decode(new Uint8Array(buf, 4, nCab)));
    let off = 4 + nCab;
    const n = msg.n;
    const vetores = [];
    (msg.campos || []).forEach(function (tipo) {
      if (tipo === "c") {
        const re = new Float32Array(buf, off, n); off += 4 * n;
        const im = new Float32Array(buf, off, n); off += 4 * n;
        vetores.push({ re: re, im: im });
      } else {
        vetores.push(new Float32Array(buf, off, n)); off += 4 * n;
      }
    });
    msg.vetores = vetores;
    return msg;
  }

  function conecta() {
    const url = (location.protocol === "https:" ? "wss://" : "ws://")
      + location.host + "/ws";
    sock = new WebSocket(url);
    sock.binaryType = "arraybuffer";

    sock.onopen = function () {
      tentativa = 0;
      MW.mensagem("ligado ao servidor");
      despacha({ tipo: "_ligado" });
    };
    sock.onmessage = function (ev) {
      if (typeof ev.data === "string") despacha(JSON.parse(ev.data));
      else despacha(decodifica(ev.data));
    };
    sock.onclose = function () {
      const espera = Math.min(8000, 500 * Math.pow(2, tentativa++));
      MW.mensagem("sem ligação; tentando de novo em " + (espera / 1000) + " s");
      setTimeout(conecta, espera);
    };
    sock.onerror = function () { try { sock.close(); } catch (e) {} };
  }

  function manda(obj) {
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function assina(topicos) { manda({ t: "assinar", topicos: topicos }); }

  return { conecta: conecta, manda: manda, em: em, assina: assina };
})();

MW.mensagem = function (txt) {
  const el = MW.q("#mensagem");
  if (el) el.textContent = txt;
};
