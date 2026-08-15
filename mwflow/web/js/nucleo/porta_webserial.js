/* Porta serial de verdade, pela API WebSerial do navegador.
 *
 * ESTA É A PEÇA QUE SUBSTITUI O SERVIDOR. No MWFlow em Python quem abre a
 * porta é o `pyserial`, dentro de uma thread. Aqui quem abre é o navegador,
 * depois de o usuário escolher a porta num diálogo do próprio navegador. Nada
 * sai da máquina: a página é estática e a porta é local.
 *
 * O QUE O NAVEGADOR EXIGE, e a interface tem de dizer ao usuário:
 *
 * 1. `navigator.serial` só existe no Chrome, no Edge e no Opera de desktop. O
 *    Firefox e o Safari não têm WebSerial, e não há como contornar.
 * 2. A página tem de estar em HTTPS ou em `localhost`. O GitHub Pages serve em
 *    HTTPS, então serve.
 * 3. `requestPort()` só pode ser chamado dentro de um gesto do usuário — um
 *    clique. Chamar na carga da página falha, e falha em silêncio se o erro
 *    não for pego.
 *
 * INTERFACE. Esta classe expõe o mesmo punhado de métodos que o driver usava
 * do pyserial: `escreve`, `leExato`, `limpaEntrada` e `fecha`. O driver não
 * sabe se está falando com esta porta ou com a simulada.
 */

"use strict";

export class ErroPorta extends Error {}

export function temWebSerial() {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

/* Identificador USB do LiteVNA64 desta bancada, lido do udev em 2026-08-15:
   Black Sphere Technologies CDC-ACM Demo, 04b4:0008. O filtro é uma sugestão
   do diálogo, não uma trava: outra unidade pode trazer outro identificador, e
   por isso a interface também oferece a escolha sem filtro. */
export const FILTROS_LITEVNA = [{ usbVendorId: 0x04b4, usbProductId: 0x0008 }];

export class PortaWebSerial {
  constructor(porta) {
    this.porta = porta;
    this.simulado = false;
    this.aberta = false;
    this._pedacos = [];
    this._total = 0;
    this._leitor = null;
    this._escritor = null;
    this._laco = null;
    this._acorda = null;
  }

  /** Abre o diálogo do navegador. Só funciona dentro de um clique. */
  static async pede(comFiltro = true) {
    if (!temWebSerial()) {
      throw new ErroPorta("este navegador não tem WebSerial. Use o Chrome, o "
        + "Edge ou o Opera de desktop.");
    }
    const opcoes = comFiltro ? { filters: FILTROS_LITEVNA } : {};
    const p = await navigator.serial.requestPort(opcoes);
    return new PortaWebSerial(p);
  }

  /** Portas que o usuário já autorizou antes, para religar sem novo diálogo. */
  static async jaAutorizadas() {
    if (!temWebSerial()) return [];
    const ps = await navigator.serial.getPorts();
    return ps.map((p) => new PortaWebSerial(p));
  }

  async abre() {
    if (this.aberta) return this;
    await this.porta.open({ baudRate: 115200, bufferSize: 1 << 16 });
    this._escritor = this.porta.writable.getWriter();
    this._leitor = this.porta.readable.getReader();
    this.aberta = true;
    this._laco = this._laceia();
    return this;
  }

  async _laceia() {
    try {
      for (;;) {
        const { value, done } = await this._leitor.read();
        if (done) break;
        if (value && value.length) {
          this._pedacos.push(value);
          this._total += value.length;
          if (this._acorda) { this._acorda(); this._acorda = null; }
        }
      }
    } catch (e) {
      // Cabo arrancado no meio da leitura. O motor vê a falta de bytes e sobe
      // a escada de recuperação; aqui só se marca a porta como fechada.
      this.aberta = false;
      if (this._acorda) { this._acorda(); this._acorda = null; }
    }
  }

  async escreve(bytes) {
    if (!this.aberta) throw new ErroPorta("porta fechada");
    await this._escritor.write(bytes);
  }

  limpaEntrada() {
    this._pedacos.length = 0;
    this._total = 0;
  }

  /** Espera até haver `n` bytes, ou até o prazo. Devolve o que houver. */
  async leExato(n, prazoMs) {
    const fim = Date.now() + prazoMs;
    while (this._total < n) {
      if (!this.aberta) break;
      const resta = fim - Date.now();
      if (resta <= 0) break;
      await new Promise((ok) => {
        const t = setTimeout(() => { this._acorda = null; ok(); },
                             Math.min(resta, 50));
        this._acorda = () => { clearTimeout(t); ok(); };
      });
    }
    return this._retira(Math.min(n, this._total));
  }

  _retira(n) {
    const saida = new Uint8Array(n);
    let posto = 0;
    while (posto < n) {
      const p = this._pedacos[0];
      const falta = n - posto;
      if (p.length <= falta) {
        saida.set(p, posto);
        posto += p.length;
        this._pedacos.shift();
      } else {
        saida.set(p.subarray(0, falta), posto);
        this._pedacos[0] = p.subarray(falta);
        posto = n;
      }
    }
    this._total -= n;
    return saida;
  }

  async fecha() {
    this.aberta = false;
    try { await this._leitor.cancel(); } catch (e) { /* já caiu */ }
    try { this._leitor.releaseLock(); } catch (e) { /* já solto */ }
    try { this._escritor.releaseLock(); } catch (e) { /* já solto */ }
    try { await this.porta.close(); } catch (e) { /* já fechada */ }
    this._pedacos.length = 0;
    this._total = 0;
  }
}
