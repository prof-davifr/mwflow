#!/usr/bin/env python3
"""Verificação de ponta a ponta, com a bancada simulada.

Sobe o servidor de verdade, fala com ele por WebSocket e HTTP como o navegador
faria, e exige que o caminho inteiro funcione: aquisição, observáveis, sessão,
gravação, calibração SOLT e curva de calibração.

O passo mais importante é o 5: depois de calibrar, o `f_res` medido tem de
voltar para a verdade do simulador. Sem calibração ele erra vários MHz — mais
que o sinal que o sensor precisa medir.

    python3 -m testes.teste_ponta_a_ponta
"""

import asyncio
import json
import os
import struct
import sys
import time

import numpy as np

_falhas = []


def exige(cond, texto, valor=""):
    print("  [%s] %s %s" % ("ok  " if cond else "FALHA", texto, valor))
    if not cond:
        _falhas.append(texto)


def decodifica(buf):
    n = struct.unpack("<I", buf[:4])[0]
    msg = json.loads(buf[4:4 + n].decode("utf-8"))
    off = 4 + n
    vet = []
    for c in msg.get("campos", []):
        k = msg["n"] * 4
        if c == "c":
            re = np.frombuffer(buf, np.float32, msg["n"], off); off += k
            im = np.frombuffer(buf, np.float32, msg["n"], off); off += k
            vet.append(re + 1j * im)
        else:
            vet.append(np.frombuffer(buf, np.float32, msg["n"], off)); off += k
    msg["vetores"] = vet
    return msg


class Cliente:
    """Um navegador de mentira."""

    def __init__(self, ws):
        self.ws = ws
        self.caixa = []
        self.tarefa = asyncio.create_task(self._le())

    async def _le(self):
        try:
            async for m in self.ws:
                self.caixa.append(decodifica(m) if isinstance(m, bytes)
                                  else json.loads(m))
        except Exception:
            pass

    async def manda(self, **kw):
        await self.ws.send(json.dumps(kw))

    async def espera(self, tipo, prazo=25.0, cond=None):
        fim = time.time() + prazo
        while time.time() < fim:
            for m in list(self.caixa):
                if m.get("tipo") == tipo and (cond is None or cond(m)):
                    return m
            await asyncio.sleep(0.05)
        return None

    def limpa(self):
        self.caixa.clear()


async def principal():
    import uvicorn
    import websockets

    from mwflow.caminhos import RAIZ
    from mwflow.motor import Motor
    from mwflow.servidor import cria_app

    # base limpa, para o teste não depender de corridas anteriores
    base = os.path.join(RAIZ, "mwflow.db")
    for suf in ("", "-wal", "-shm"):
        try:
            os.remove(base + suf)
        except OSError:
            pass

    motor = Motor(simulado=True, turbo=True, deriva=False)
    app = cria_app(motor)
    cfg = uvicorn.Config(app, host="127.0.0.1", port=8799, log_level="error")
    servidor = uvicorn.Server(cfg)
    t = asyncio.create_task(servidor.serve())
    while not servidor.started:
        await asyncio.sleep(0.05)

    import urllib.request

    def _http(caminho, corpo=None):
        url = "http://127.0.0.1:8799" + caminho
        if corpo is None:
            return json.load(urllib.request.urlopen(url, timeout=30))
        req = urllib.request.Request(
            url, data=json.dumps(corpo).encode(),
            headers={"Content-Type": "application/json"})
        return json.load(urllib.request.urlopen(req, timeout=30))

    async def http(caminho, corpo=None):
        """O servidor roda NESTE laco de eventos. Uma chamada HTTP bloqueante
        aqui travaria os dois lados; por isso ela vai para outra thread."""
        return await asyncio.to_thread(_http, caminho, corpo)

    try:
        async with websockets.connect("ws://127.0.0.1:8799/ws") as ws:
            c = Cliente(ws)

            print("\n1. Aquisição e observáveis")
            await c.manda(t="configurar", f_inicio_hz=1.30e9, f_fim_hz=2.00e9,
                          n_pontos=401, vpf=1, medias=1)
            await c.manda(t="modo", modo="varredura",
                          banda_hz=[1.30e9, 2.00e9])
            v = await c.espera("varredura")
            exige(v is not None, "chegou uma varredura")
            exige(v and len(v["vetores"]) == 2 and v["vetores"][0].size == v["n"],
                  "quadro binário decodifica", "%d pontos" % (v["n"] if v else 0))
            e = await c.espera("escalar", cond=lambda m: m.get("ok"))
            exige(e is not None, "chegou um ajuste aprovado")
            f_bruto = e["valores"]["f_res"] if e else float("nan")
            print("      f_res SEM calibração: %.3f MHz" % (f_bruto / 1e6))

            print("\n2. Espectrograma e estado")
            await c.manda(t="assinar", topicos=["estado", "erro", "escalar",
                                                "varredura", "linha_espectro",
                                                "cal", "ponto", "captura",
                                                "mensagem"])
            le = await c.espera("linha_espectro")
            exige(le is not None and le["vetores"][0].size == le["n"],
                  "chegou uma linha de espectro")
            st = await c.espera("estado")
            exige(st and st["aparelho"] == "simulado",
                  "o estado diz que o aparelho é simulado")
            exige(st and st["pontos_max"] == 1024,
                  "o teto de pontos medido chega ao cliente")

            print("\n3. Sessão e gravação")
            s = await http("/api/sessao", dict(nome="teste_%d" % int(time.time()),
                                         operador="teste", gravar=True))
            exige("id" in s, "sessão criada", s.get("nome", ""))
            await asyncio.sleep(1.0)
            csvs = os.listdir(os.path.join(s["pasta"], "varreduras"))
            exige(len(csvs) > 0, "CSV nativo do LiteVNA gravado",
                  "%d arquivo(s)" % len(csvs))
            from mwflow.armazenamento import le_csv_litevna
            ff, aa, bb = le_csv_litevna(os.path.join(s["pasta"], "varreduras",
                                                     sorted(csvs)[0]))
            exige(len(ff) == 401 and abs(ff[0] - 1.30e9) < 1,
                  "o CSV relê com a grade certa", "%d pontos" % len(ff))

            print("\n4. Calibração SOLT com os padrões simulados")
            for padrao in ("aberto", "curto", "carga", "thru"):
                c.limpa()
                await c.manda(t="sim_dut", dut=padrao)
                await asyncio.sleep(0.4)
                await c.manda(t="cal_medir", padrao=padrao, n_medias=8)
                r = await c.espera("cal", cond=lambda m: m.get("estado") == "medido")
                exige(r is not None, "padrão %s medido" % padrao)
            d = await http("/api/cal/resolver", dict(kit="sma_generico",
                                               nome="cal_teste"))
            exige(not d.get("erro"), "calibração resolvida",
                  "condição máxima %.1f" % d.get("cond_max", -1))
            d2 = await http("/api/cal/aplicar", dict(nome="cal_teste", modo="inicial"))
            exige(d2.get("estado") == "aplicada", "calibração aplicada")

            print("\n5. O teste que importa: f_res depois da calibração")
            await c.manda(t="sim_dut", dut="ressoador")
            await asyncio.sleep(0.5)
            c.limpa()
            e2 = await c.espera("escalar", cond=lambda m: m.get("ok"))
            from mwflow.vna.simulador import F0_PADRAO, Q_PADRAO
            if e2:
                f_cal = e2["valores"]["f_res"]
                q_cal = e2["valores"]["q"]
                print("      verdade            : %.3f MHz | Q = %.3f"
                      % (F0_PADRAO / 1e6, Q_PADRAO))
                print("      sem calibração     : %.3f MHz  (erro %+.0f kHz)"
                      % (f_bruto / 1e6, (f_bruto - F0_PADRAO) / 1e3))
                print("      COM calibração     : %.3f MHz | Q = %.3f  (erro %+.0f kHz)"
                      % (f_cal / 1e6, q_cal, (f_cal - F0_PADRAO) / 1e3))
                exige(abs(f_cal - F0_PADRAO) < abs(f_bruto - F0_PADRAO) / 2,
                      "a calibração melhora f_res em pelo menos 2 vezes")
                print("      O resíduo que sobra NAO e defeito: e o termo e22,")
                print("      inobservavel sem chave de reversao. Ele enviesa")
                print("      f_res e Q. A defesa e fisica: um atenuador na porta 2.")
                exige(abs(q_cal - Q_PADRAO) / Q_PADRAO < 0.10,
                      "Q dentro de 10 % da verdade",
                      "%.1f %%" % (100 * abs(q_cal - Q_PADRAO) / Q_PADRAO))
            else:
                exige(False, "chegou ajuste depois da calibração")

            print("\n6. Reverificação (colchete)")
            for padrao in ("aberto", "curto", "carga"):
                await c.manda(t="cal_esquecer", padrao=padrao)
            for padrao in ("aberto", "curto", "carga"):
                c.limpa()
                await c.manda(t="sim_dut", dut=padrao)
                await asyncio.sleep(0.4)
                await c.manda(t="cal_medir", padrao=padrao, n_medias=8)
                await c.espera("cal", cond=lambda m: m.get("estado") == "medido")
            r = await http("/api/cal/reverificar", {})
            exige(r.get("veredito") == "aprovado", "reverificação aprovada",
                  "carga em %.1f dB" % r.get("carga", {}).get("pior_db", 0))

            print("\n7. Curva de calibração")
            await c.manda(t="sim_dut", dut="ressoador")
            await asyncio.sleep(0.4)
            cur = await http("/api/curva", dict(
                grandeza_x="concentracao", unidade_x="%vol",
                covariavel="temperatura", unidade_cov="°C",
                observavel="derivado:f_res"))
            exige("id" in cur, "curva criada", "id %s" % cur.get("id"))
            for k, x in enumerate([0.0, 2.0, 4.0, 6.0, 8.0]):
                # o simulador não muda com o analito, então desloca-se o
                # ressoador na mão para produzir uma curva de verdade
                motor.vna.serial.f0 = F0_PADRAO - x * 5.4e6
                await asyncio.sleep(0.3)
                c.limpa()
                await c.manda(t="capturar", curva_id=cur["id"],
                              obs="derivado:f_res", x=x, cov=24.0 + 0.1 * k,
                              replica="A", ordem=k + 1, n_med=4)
                p = await c.espera("ponto", prazo=30)
                exige(p is not None, "ponto capturado em x = %.1f" % x,
                      "" if p is None else "Y = %.3f MHz ± %.4f"
                      % (p["y"] / 1e6, p["y_desvio"] / 1e6))
            a = await http("/api/curva/%d/ajustar" % cur["id"],
                     dict(tipo="linear", sigma_origem="medida"))
            exige(not a.get("erro"), "curva ajustada")
            if not a.get("erro"):
                print("      " + a["resumo"].replace("\n", "\n      "))
                sens_mhz = a["sensibilidade"] / 1e6
                exige(abs(sens_mhz + 5.4) < 0.3,
                      "a sensibilidade recupera os -5,4 MHz/%vol impostos",
                      "%.2f MHz/%%vol" % sens_mhz)
                exige(a["r2"] > 0.999, "R² alto", "%.6f" % a["r2"])
            # Mede DE VERDADE em x = 3 e exige que a inversa devolva 3. Usar
            # um Y calculado da verdade do simulador testaria a coisa errada:
            # a curva medida tem o intercepto que a calibração deixou.
            motor.vna.serial.f0 = F0_PADRAO - 3.0 * 5.4e6
            await asyncio.sleep(0.3)
            c.limpa()
            # de propósito com o nome ANTIGO do campo: há curvas e scripts que
            # ainda mandam `temperatura_c`, e o apelido tem de continuar valendo
            await c.manda(t="capturar", curva_id=None, obs="derivado:f_res",
                          x=3.0, temperatura_c=24.0, replica="cego", n_med=4)
            pcego = await c.espera("ponto", prazo=30)
            exige(pcego is not None and pcego.get("cov") == 24.0,
                  "o campo antigo `temperatura_c` ainda alimenta a covariável",
                  "cov = %s" % (pcego or {}).get("cov"))
            inv = await http("/api/curva/%d/inversa" % cur["id"],
                       dict(y=pcego["y"], m=4, tipo="linear"))
            exige(not inv.get("erro") and abs(inv.get("x", 99) - 3.0) < 0.3,
                  "previsão inversa acerta uma amostra cega de x = 3",
                  "" if inv.get("erro") else "x = %.3f ± %.3f"
                  % (inv["x"], inv["meia_largura"]))
            fora = await http("/api/curva/%d/inversa" % cur["id"],
                        dict(y=F0_PADRAO + 50e6, m=1, tipo="linear"))
            exige(bool(fora.get("erro")),
                  "leitura fora da faixa é RECUSADA", fora.get("erro", "")[:48])

            print("\n8. Exportação e encerramento")
            ex = await http("/api/exportar", dict(nome="saida_teste"))
            exige(all(os.path.exists(p) for p in ex.get("arquivos", [])),
                  "Touchstone, CSV e npz escritos",
                  ", ".join(os.path.basename(p) for p in ex.get("arquivos", [])))
            z = np.load([p for p in ex["arquivos"] if p.endswith(".npz")][0])
            exige(set(z.files) >= {"f", "s11", "s21"},
                  "o npz usa as chaves de sensor_etanol.ajuste",
                  str(sorted(z.files)))
            fim = await http("/api/sessao/encerrar", dict(modo_cal="inicial"))
            exige(fim.get("encerrada"), "sessão encerrada")
            nums = os.path.join(s["pasta"], "numeros_%s.txt" % s["nome"])
            exige(os.path.exists(nums), "numeros_*.txt escrito")

            c.tarefa.cancel()
    finally:
        servidor.should_exit = True
        await asyncio.sleep(0.5)
        t.cancel()

    print()
    if _falhas:
        print("FALHOU em %d verificações:" % len(_falhas))
        for f in _falhas:
            print("  - %s" % f)
        return 1
    print("Ponta a ponta: tudo passou.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(principal()))
