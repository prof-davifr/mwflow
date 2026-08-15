#!/usr/bin/env python3
"""Servidor local do MWFlow.

Starlette, e não FastAPI: a instalação global do FastAPI nesta máquina está
quebrada (falta `fastapi/applications.py`), e para poucas rotas e um WebSocket
a camada de validação do FastAPI não se paga. A API de WebSocket é do Starlette
de qualquer forma.

FORMATO DO WEBSOCKET
--------------------
Controle vai em texto JSON. Vetores vão em quadro binário:

    [uint32 pouco-significativo-primeiro: tamanho do cabeçalho]
    [cabeçalho JSON em UTF-8, completado até múltiplo de 4]
    [carga em float32]

O completamento até quatro bytes existe para o `Float32Array` do navegador
apontar direto para o buffer, sem cópia. A 15 quadros por segundo com 1024
pontos isso dá cerca de 250 kB/s; em JSON seriam uns 2 MB/s, e ainda com o
custo de interpretar o texto. float32 é a precisão do que se desenha; no disco
tudo continua em float64.
"""

import argparse
import asyncio
import contextlib
import json
import math
import os
import struct
import sys
import time

import numpy as np
import uvicorn
from starlette.applications import Starlette
from starlette.responses import HTMLResponse, JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect

from mwflow import armazenamento as az
from mwflow import curva as cv
from mwflow import kit_cal, observaveis as ob, solt
from mwflow.caminhos import SESSOES, WEB, garante
from mwflow.motor import Motor

TOPICOS_PADRAO = ["estado", "erro", "escalar", "varredura", "ponto",
                  "captura", "mensagem", "cal", "curva"]


class EstaticosSemCache(StaticFiles):
    """Serve os arquivos da interface sem cache.

    O MWFlow roda só na máquina local, então cache não economiza nada. Em
    compensação, um JS velho preso no navegador depois de uma edição custa uma
    hora de confusão.
    """

    def file_response(self, *a, **kw):
        r = super().file_response(*a, **kw)
        r.headers["Cache-Control"] = "no-store, must-revalidate"
        return r


# ------------------------------------------------------------- codificação
def _limpa_json(o):
    """Troca NaN e infinito por `None`. O JSON estrito não os aceita."""
    if isinstance(o, dict):
        return {k: _limpa_json(v) for k, v in o.items() if not k.startswith("_")}
    if isinstance(o, (list, tuple)):
        return [_limpa_json(v) for v in o]
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (float, np.floating)):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, np.ndarray):
        return _limpa_json(o.tolist())
    return o


def codifica(msg):
    """Devolve (texto, None) ou (None, bytes), conforme haja vetor."""
    arrays = msg.get("_arrays")
    if not arrays:
        return json.dumps(_limpa_json(msg), ensure_ascii=False), None
    partes, campos = [], []
    for a in arrays:
        a = np.asarray(a)
        if np.iscomplexobj(a):
            partes.append(np.real(a).astype(np.float32))
            partes.append(np.imag(a).astype(np.float32))
            campos.append("c")
        else:
            partes.append(a.astype(np.float32))
            campos.append("r")
    cab = _limpa_json(msg)
    cab["campos"] = campos
    bruto = json.dumps(cab, ensure_ascii=False).encode("utf-8")
    bruto += b" " * ((-len(bruto)) % 4)
    carga = b"".join(x.tobytes() for x in partes)
    return None, struct.pack("<I", len(bruto)) + bruto + carga


def _relativo(msg):
    """Em CW o tempo absoluto não cabe em float32.

    Um instante Unix vale ~1,8e9 s; ali o passo do float32 já é de 128 s, o que
    destruiria a base de tempo. O cabeçalho leva `t0` em float64 e a carga leva
    só a diferença.
    """
    if msg.get("tipo") != "amostras_cw":
        return msg
    t, s = msg["_arrays"]
    m = dict(msg)
    m["t0"] = float(t[0])
    m["_arrays"] = ((t - t[0]).astype(np.float32), s)
    return m


# ------------------------------------------------------------------- estado
class App:
    """Costura entre o motor, o banco e as rotas."""

    def __init__(self, motor):
        self.motor = motor
        self.gravadora = az.Gravadora()
        self.gravadora.start()
        self.gravadora.pronta.wait(5)
        kit_cal.instala_embutidos()
        self.curva_atual = None

    # ------------------------------------------------------------- sessão
    def nova_sessao(self, d):
        s = az.Sessao(self.gravadora, nome=d.get("nome"),
                      operador=d.get("operador", ""),
                      descricao=d.get("descricao", ""),
                      aparelho=("simulado" if self.motor.simulado else "litevna"),
                      firmware=(self.motor.identidade or {}).get("firmware", ""),
                      config=self.motor.estado()["config"])
        self.motor.sessao = s
        self.motor.gravando = bool(d.get("gravar", True))
        return dict(id=s.id, nome=s.nome, pasta=s.pasta)

    def encerra_sessao(self, d):
        s = self.motor.sessao
        if not s:
            return dict(erro="não há sessão aberta")
        rev = d.get("reverificacao")
        s.encerra(reverif=rev, modo_cal=d.get("modo_cal"))
        self.escreve_numeros(s)
        nome = s.nome
        self.motor.sessao = None
        self.motor.gravando = False
        return dict(nome=nome, encerrada=True)

    def escreve_numeros(self, s):
        """Despejo em texto do que a sessão produziu.

        Mesmo hábito dos scripts de pós-processamento do repositório: um
        arquivo `numeros_*.txt` com tudo o que foi medido, para o relatório não
        depender de ninguém copiar número à mão.
        """
        con = az.conecta(leitura=True)
        linhas = ["Sessão %s" % s.nome,
                  "gerado em %s" % time.strftime("%Y-%m-%d %H:%M:%S"), ""]
        r = con.execute("SELECT COUNT(*) c, MIN(t) a, MAX(t) b FROM varreduras "
                        "WHERE sessao_id=?", (s.id,)).fetchone()
        if r and r["c"]:
            linhas.append("varreduras gravadas : %d" % r["c"])
            linhas.append("duração             : %.1f min" % ((r["b"] - r["a"]) / 60))
        aj = con.execute("SELECT COUNT(*) n, AVG(f_res) m, "
                         "AVG(q) q FROM ajustes WHERE sessao_id=? AND ok=1",
                         (s.id,)).fetchone()
        if aj and aj["n"]:
            linhas += ["ajustes aprovados   : %d" % aj["n"],
                       "f_res média         : %.4f MHz" % (aj["m"] / 1e6),
                       "Q médio             : %.3f" % aj["q"]]
        for c in con.execute("SELECT * FROM curvas WHERE sessao_id=?", (s.id,)):
            c = descreve_curva(c)
            linhas += ["", "curva %s: %s contra %s, em %s"
                       % (c["nome"], c["observavel"], c["grandeza_x"],
                          c["unidade_x"] or "unidade nenhuma")]
            for a in con.execute("SELECT * FROM ajustes_curva WHERE curva_id=? "
                                 "ORDER BY id DESC LIMIT 1", (c["id"],)):
                linhas.append("  %s" % cv.texto_resumo(
                    dict(json.loads(a["coefs_json"]) if False else {},
                         erro=None, faixa=[a["faixa_lo"], a["faixa_hi"]],
                         sensibilidade=a["sensibilidade"], n=a["n"], r2=a["r2"],
                         lod=a["lod"], sigma_y=a["sigma_y"],
                         sigma_origem=a["sigma_origem"]),
                    c["unidade_x"], "").replace("\n", "\n  "))
        con.close()
        with open(os.path.join(s.pasta, "numeros_%s.txt" % s.nome), "w",
                  encoding="utf-8") as fh:
            fh.write("\n".join(linhas) + "\n")

    # -------------------------------------------------------------- curva
    def nova_curva(self, d):
        con = az.conecta()
        e = self.motor.estado()
        gx = d.get("grandeza_x") or d.get("analito") or ""
        cur = con.execute(
            "INSERT INTO curvas (nome, criada_em, sessao_id, analito, "
            "unidade_x, grandeza_x, covariavel, unidade_cov, cov_exigida, "
            "observavel, param, banda_lo_hz, banda_hi_hz, "
            "f_alvo_hz, semente, descricao) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (d.get("nome") or time.strftime("curva_%Y%m%d_%H%M%S"),
             time.strftime("%Y-%m-%dT%H:%M:%S"),
             self.motor.sessao.id if self.motor.sessao else None,
             gx, d.get("unidade_x", ""), gx,
             d.get("covariavel") or "", d.get("unidade_cov") or "",
             0 if d.get("cov_exigida") is False else 1,
             d.get("observavel", "derivado:f_res"), e["param"],
             e["banda_hz"][0], e["banda_hz"][1], d.get("f_alvo_hz"),
             d.get("semente"), d.get("descricao", "")))
        cid = cur.lastrowid
        con.commit()
        con.close()
        self.curva_atual = cid
        return dict(id=cid)

    def grava_ponto(self, msg):
        cid = msg.get("curva_id") or self.curva_atual
        if not cid:
            return
        # `cov` é o valor da covariável da curva, qualquer que seja ela. O
        # campo antigo `temperatura_c` continua aceito na entrada, e é o que os
        # pontos gravados antes desta versão têm.
        cval = msg.get("cov")
        if cval is None:
            cval = msg.get("temperatura_c")
        con = az.conecta()
        con.execute(
            "INSERT INTO pontos_curva (curva_id, x, y, y_desvio, n_med, "
            "brutos_json, cov, replica, ordem_sorteada, x_ref, t, "
            "nota) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, msg.get("x"), msg.get("y"), msg.get("y_desvio"),
             msg.get("n_med", 1), json.dumps(msg.get("brutos", [])),
             cval, msg.get("replica"), msg.get("ordem"),
             msg.get("x_ref"), msg.get("t"), msg.get("nota")))
        con.commit()
        con.close()

    def pontos(self, cid):
        con = az.conecta(leitura=True)
        r = [dict(x) for x in con.execute(
            "SELECT * FROM pontos_curva WHERE curva_id=? ORDER BY t", (cid,))]
        c = con.execute("SELECT * FROM curvas WHERE id=?", (cid,)).fetchone()
        con.close()
        for p in r:
            if p.get("cov") is None:
                p["cov"] = p.get("temperatura_c")
        return dict(curva=descreve_curva(c), pontos=r)

    def ajusta(self, cid, d):
        dados = self.pontos(cid)
        c = dados["curva"] or {}
        pts = [p for p in dados["pontos"] if p["incluido"]]
        if len(pts) < 3:
            return dict(erro="a curva tem menos de 3 pontos incluídos")
        x = [p["x"] for p in pts]
        y = [p["y"] for p in pts]
        C = [p["cov"] for p in pts]
        unid_y = self._unidade_y(dados["curva"])

        sigma = d.get("sigma_y")
        origem = d.get("sigma_origem", "medida")
        if origem == "medida":
            desvios = [p["y_desvio"] for p in pts
                       if p["y_desvio"] and p["n_med"] > 1]
            if desvios:
                # desvio combinado dentro dos níveis
                sigma = float(np.sqrt(np.mean(np.square(desvios))))
            elif sigma is None:
                origem = "residuo"

        tipo = cv.canon(d.get("tipo", "linear"))
        a = cv.ajusta_curva(
            x, y, tipo=tipo,
            faixa=(d.get("faixa_lo"), d.get("faixa_hi")),
            cov_valores=(C if tipo == "covariavel" else None),
            sigma_y=sigma, sigma_origem=origem,
            unidade_x=c["unidade_x"], unidade_y=unid_y,
            nome_cov=c["covariavel"], unidade_cov=c["unidade_cov"])
        if a.get("erro"):
            return a
        a["resumo"] = cv.texto_resumo(a, c["unidade_x"], unid_y)
        # alinhados com os resíduos: uma faixa deixa pontos de fora
        a["ordem"] = [pts[i]["ordem_sorteada"] or i + 1 for i in a["indices"]]
        # `cov_pontos`, e não `cov`: `cov` já é a matriz de covariância do ajuste
        a["cov_pontos"] = [C[i] for i in a["indices"]]
        a["unidade_y"] = unid_y

        con = az.conecta()
        con.execute(
            "INSERT INTO ajustes_curva (curva_id, criado_em, tipo, grau, "
            "faixa_lo, faixa_hi, n, coefs_json, cov_json, r2, r2_aj, s_yx, "
            "sensibilidade, unidade_sens, sigma_y, sigma_origem, lod, loq) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, a["criado_em"], a["tipo"], a["grau"], a["faixa"][0],
             a["faixa"][1], a["n"], json.dumps(a["coefs"]),
             json.dumps(a["cov"]), a["r2"], a["r2_aj"], a["s_yx"],
             a["sensibilidade"], a["unidade_sens"], a["sigma_y"],
             a["sigma_origem"], a["lod"], a["loq"]))
        con.commit()
        con.close()
        return a

    def _unidade_y(self, c):
        if not c:
            return ""
        obs = c["observavel"] or ""
        tipo, _, nome = obs.partition(":")
        if tipo == "derivado":
            u = ob.UNIDADE_ESCALAR.get(nome, "")
            return u
        o = ob.REGISTRO.get(nome)
        return o.unidade if o else ""

    def csv_curva(self, cid):
        """A coluna `cov` leva a covariável da curva, seja ela qual for.

        O nome da coluna é fixo de propósito: um cabeçalho que mudasse com a
        curva quebraria todo script que lesse a exportação. Quem é a covariável
        está gravado na curva, e o manual da tela diz isso.
        """
        d = self.pontos(cid)
        cab = ("x;y;y_desvio;n_med;cov;replica;ordem_sorteada;"
               "x_ref;t_iso;incluido;nota")
        L = [cab]
        for p in d["pontos"]:
            L.append(";".join([
                _v(p["x"]), _v(p["y"]), _v(p["y_desvio"]), str(p["n_med"]),
                _v(p["cov"]), p["replica"] or "",
                str(p["ordem_sorteada"] or ""), _v(p["x_ref"]),
                time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(p["t"])),
                str(p["incluido"]), (p["nota"] or "").replace(";", ",")]))
        return "\n".join(L) + "\n"

    # ------------------------------------------------------------ calibração
    def resolve_cal(self, d):
        m = self.motor.cal_medidas
        faltam = [k for k in ("aberto", "curto", "carga") if k not in m]
        if faltam:
            return dict(erro="faltam padrões: %s" % ", ".join(faltam))
        kit = kit_cal.carrega_kit(d.get("kit", "sma_generico"))
        f = m["aberto"][0]
        for k in ("curto", "carga"):
            if len(m[k][0]) != len(f) or abs(m[k][0][0] - f[0]) > 1:
                return dict(erro="os padrões foram medidos em grades "
                                 "diferentes; refaça a calibração")
        medidos = {k: m[k][1] for k in ("aberto", "curto", "carga")}
        t = solt.resolve_uma_porta(f, medidos, kit)
        cond = float(np.max(t["cond"]))
        aviso = None
        if cond > solt.COND_LIMITE:
            aviso = ("condicionamento ruim (%.1e). Os três padrões ficaram "
                     "perto demais na carta de Smith — quase sempre é padrão "
                     "trocado, mal rosqueado ou danificado." % cond)
        if "thru" in m:
            iso = m["isolamento"][2] if "isolamento" in m else None
            t.update(solt.resolve_transmissao(f, m["thru"][2], t["e11"],
                                              isolamento=iso, kit=kit))
        nome = d.get("nome") or time.strftime("cal_%Y%m%d_%H%M%S")
        meta = solt.salva(nome, t, kit, meta=dict(
            aparelho=("simulado" if self.motor.simulado else "litevna"),
            firmware=(self.motor.identidade or {}).get("firmware", ""),
            isolamento=int("isolamento" in m),
            temperatura_c=d.get("temperatura_c"), nota=d.get("nota")))
        con = az.conecta()
        con.execute(
            "INSERT OR REPLACE INTO conjuntos_cal (nome, criado_em, tipo, "
            "f_inicio_hz, f_passo_hz, n, kit_json, isolamento, medias, "
            "cond_max, arquivo, aparelho, firmware, temperatura_c, nota) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (nome, meta["criado_em"], meta["tipo"], float(f[0]),
             float(f[1] - f[0]) if len(f) > 1 else 0.0, len(f),
             json.dumps(kit), meta.get("isolamento", 0), d.get("n_medias"),
             cond, meta["arquivo"], meta.get("aparelho"),
             meta.get("firmware"), d.get("temperatura_c"), d.get("nota")))
        con.commit()
        con.close()
        return dict(nome=nome, cond_max=cond, tipo=meta["tipo"], aviso=aviso,
                    n=len(f), f_inicio_hz=float(f[0]), f_fim_hz=float(f[-1]))

    def reverifica(self, d):
        m = self.motor.cal_medidas
        if not self.motor.cal_nome:
            return dict(erro="não há calibração aplicada para reverificar")
        faltam = [k for k in ("aberto", "curto", "carga") if k not in m]
        if faltam:
            return dict(erro="meça os padrões de novo: faltam %s"
                        % ", ".join(faltam))
        termos, meta = solt.carrega(self.motor.cal_nome)
        f = m["aberto"][0]
        try:
            t = solt.interpola(termos, f)
        except ValueError as e:
            return dict(erro=str(e))
        kit = kit_cal.carrega_kit(meta.get("kit", {}).get("nome", "sma_generico")
                                  if isinstance(meta.get("kit"), dict)
                                  else "sma_generico")
        r = solt.reverifica(f, t, {k: m[k][1] for k in
                                   ("aberto", "curto", "carga")}, kit)
        r["cal"] = self.motor.cal_nome
        if self.motor.sessao:
            self.motor.sessao.grava_evento("info", "reverificacao",
                                           json.dumps(r))
        return r


def _v(x):
    if x is None:
        return ""
    return ("%.9g" % float(x)).replace(".", ",")


def descreve_curva(c):
    """Nomes e unidades de uma curva, com as curvas antigas em pé.

    O X e a covariável passaram a ser grandezas que o operador nomeia. Antes
    disso o X era sempre um analito e a covariável era sempre a temperatura em
    grau Celsius; as curvas gravadas naquele tempo não têm os campos novos, e é
    aqui que elas ganham o sentido que tinham.
    """
    if c is None:
        return None
    d = dict(c)
    d["grandeza_x"] = d.get("grandeza_x") or d.get("analito") or "X"
    d["unidade_x"] = d.get("unidade_x") or ""
    if d.get("covariavel"):
        d["unidade_cov"] = d.get("unidade_cov") or ""
    else:
        d["covariavel"], d["unidade_cov"] = "temperatura", "°C"
    d["cov_exigida"] = 1 if d.get("cov_exigida", 1) else 0
    return d


# ---------------------------------------------------------------- aplicação
def cria_app(motor):
    est = App(motor)

    async def raiz(request):
        """Serve a interface, declarando que ela tem um servidor por trás.

        O MESMO `index.html` roda nos dois modos. Quando o arquivo é servido
        estático — pelo GitHub Pages, por exemplo — o núcleo em JavaScript
        assume e fala com o aparelho pelo WebSerial. Aqui, o marcador vira uma
        declaração de modo e aquele núcleo se desliga sozinho, senão haveria
        dois motores disputando a mesma porta serial.
        """
        with open(os.path.join(WEB, "index.html"), encoding="utf-8") as fh:
            html = fh.read()
        html = html.replace(
            "<!--MODO-->", '<script>window.MWFLOW_MODO="servidor";</script>')
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    async def api_observaveis(request):
        return JSONResponse(dict(observaveis=ob.catalogo(),
                                 unidade_escalar=ob.UNIDADE_ESCALAR,
                                 rotulo_escalar=ob.ROTULO_ESCALAR))

    async def api_estado(request):
        return JSONResponse(_limpa_json(motor.estado()))

    async def api_kits(request):
        return JSONResponse(dict(kits=kit_cal.lista_kits(),
                                 cals=solt.lista()))

    async def api_sessao(request):
        d = await request.json()
        if request.url.path.endswith("encerrar"):
            return JSONResponse(_limpa_json(est.encerra_sessao(d)))
        return JSONResponse(_limpa_json(est.nova_sessao(d)))

    async def api_curvas(request):
        """Lista as curvas. Sem isto, recarregar a página perde a curva em
        edição e os pontos ficam órfãos na base."""
        con = az.conecta(leitura=True)
        r = [descreve_curva(x) for x in con.execute(
            "SELECT c.*, (SELECT COUNT(*) FROM pontos_curva p "
            "WHERE p.curva_id=c.id) n_pontos FROM curvas c "
            "ORDER BY c.id DESC LIMIT 50")]
        con.close()
        return JSONResponse(dict(curvas=_limpa_json(r), atual=est.curva_atual))

    async def api_curva_nova(request):
        return JSONResponse(_limpa_json(est.nova_curva(await request.json())))

    async def api_curva_definicao(request):
        """Renomeia o X e a covariável de uma curva já aberta.

        Só rótulo muda aqui: nenhum número medido depende do nome da grandeza.
        Sem esta rota, editar os campos de definição não teria efeito nenhum
        sobre a curva na tela, e o operador ficaria olhando um campo que não
        obedece.
        """
        cid = int(request.path_params["cid"])
        d = await request.json()
        gx = (d.get("grandeza_x") or "").strip()
        con = az.conecta()
        con.execute(
            "UPDATE curvas SET grandeza_x=?, analito=?, unidade_x=?, "
            "covariavel=?, unidade_cov=?, cov_exigida=? WHERE id=?",
            (gx, gx, (d.get("unidade_x") or "").strip(),
             (d.get("covariavel") or "").strip(),
             (d.get("unidade_cov") or "").strip(),
             0 if d.get("cov_exigida") is False else 1, cid))
        con.commit()
        con.close()
        return JSONResponse(dict(ok=True))

    async def api_curva_pontos(request):
        cid = int(request.path_params["cid"])
        return JSONResponse(_limpa_json(est.pontos(cid)))

    async def api_curva_ajustar(request):
        cid = int(request.path_params["cid"])
        return JSONResponse(_limpa_json(est.ajusta(cid, await request.json())))

    async def api_curva_inversa(request):
        cid = int(request.path_params["cid"])
        d = await request.json()
        a = est.ajusta(cid, d)
        if a.get("erro"):
            return JSONResponse(_limpa_json(a))
        r = cv.inversa(a, float(d["y"]), m=int(d.get("m", 1)),
                       cov_valor=d.get("cov", d.get("temperatura_c")))
        return JSONResponse(_limpa_json(r))

    async def api_curva_ponto_editar(request):
        d = await request.json()
        con = az.conecta()
        if d.get("apagar"):
            con.execute("DELETE FROM pontos_curva WHERE id=?", (d["id"],))
        else:
            con.execute("UPDATE pontos_curva SET incluido=?, nota=COALESCE(?,nota) "
                        "WHERE id=?", (1 if d.get("incluido") else 0,
                                       d.get("nota"), d["id"]))
        con.commit()
        con.close()
        return JSONResponse(dict(ok=True))

    async def api_curva_csv(request):
        cid = int(request.path_params["cid"])
        return PlainTextResponse(est.csv_curva(cid), media_type="text/csv")

    async def api_planejar(request):
        d = await request.json()
        return JSONResponse(_limpa_json(cv.planeja_serie(
            float(d["x_min"]), float(d["x_max"]), float(d["passo"]),
            int(d.get("replicas", 1)), d.get("referencia"),
            int(d.get("intercalar", 3)), d.get("semente"))))

    async def api_r2(request):
        """R² frequência a frequência, sobre as varreduras gravadas da curva."""
        cid = int(request.path_params["cid"])
        d = est.pontos(cid)
        pts = [p for p in d["pontos"] if p["incluido"] and p["varredura_id"]]
        if len(pts) < 3:
            return JSONResponse(dict(
                erro="a varredura de R² precisa de 3 pontos ou mais com "
                     "varredura gravada. Ligue a gravação antes de capturar."))
        con = az.conecta(leitura=True)
        linhas, xs = [], []
        for p in pts:
            v = con.execute("SELECT * FROM varreduras WHERE id=?",
                            (p["varredura_id"],)).fetchone()
            if not v:
                continue
            s11, s21 = az.desempacota(v["dados"], v["n"])
            s = s21 if (d["curva"]["param"] or "s21") == "s21" else s11
            with np.errstate(divide="ignore", invalid="ignore"):
                linhas.append(20 * np.log10(np.abs(s)))
            xs.append(p["x"])
            f = v["f_inicio_hz"] + v["f_passo_hz"] * np.arange(v["n"])
        con.close()
        if len(linhas) < 3:
            return JSONResponse(dict(erro="varreduras insuficientes"))
        return JSONResponse(_limpa_json(
            cv.varredura_r2(f, np.array(linhas), np.array(xs))))

    async def api_cal_resolver(request):
        return JSONResponse(_limpa_json(est.resolve_cal(await request.json())))

    async def api_cal_aplicar(request):
        d = await request.json()
        return JSONResponse(_limpa_json(motor.aplica_correcao(
            d.get("nome"), d.get("nome_fim"), d.get("modo", "inicial"))))

    async def api_cal_reverificar(request):
        return JSONResponse(_limpa_json(est.reverifica(await request.json())))

    async def api_exportar(request):
        """Touchstone e npz da última varredura."""
        d = await request.json()
        if not motor._ultima:
            return JSONResponse(dict(erro="não há varredura para exportar"))
        f, s11, s21, cab = motor._ultima
        pasta = (motor.sessao.pasta if motor.sessao
                 else garante(os.path.join(SESSOES, "_avulsas")))
        base = os.path.join(pasta, d.get("nome") or time.strftime("varredura_%H%M%S"))
        meta = dict(sessao=(motor.sessao.nome if motor.sessao else "avulsa"),
                    seq=cab["seq"],
                    aparelho=("simulado" if motor.simulado else "LiteVNA64"),
                    firmware=(motor.identidade or {}).get("firmware"),
                    calibracao=(motor.cal_nome or "nenhuma (dado bruto)"),
                    temperatura_c=d.get("temperatura_c"), nota=d.get("nota"))
        az.escreve_touchstone(base + ".s2p", f, s11, s21, meta)
        az.escreve_csv_litevna(base + ".csv", f, s11, s21)
        az.exporta_npz(base + ".npz", f, s11, s21)
        return JSONResponse(dict(arquivos=[base + ".s2p", base + ".csv",
                                           base + ".npz"]))

    async def ws(websocket):
        await websocket.accept()
        a = motor.assina(TOPICOS_PADRAO)
        await websocket.send_text(codifica(motor.estado())[0])

        async def envia():
            while a.vivo:
                for msg in await a.proximo():
                    if msg.get("tipo") == "ponto":
                        est.grava_ponto(msg)
                    txt, bin_ = codifica(_relativo(msg))
                    if txt is not None:
                        await websocket.send_text(txt)
                    else:
                        await websocket.send_bytes(bin_)

        tarefa = asyncio.create_task(envia())
        try:
            while True:
                try:
                    cmd = json.loads(await websocket.receive_text())
                except json.JSONDecodeError:
                    continue
                t = cmd.get("t")
                if t == "assinar":
                    a.assina(cmd.get("topicos") or TOPICOS_PADRAO)
                elif t == "quedas":
                    e = motor.estado()
                    e["quedas"] = dict(a.quedas)
                    e["perdas_gravacao"] = est.gravadora.perdas
                    a.entrega(e)
                else:
                    if t == "capturar" and not cmd.get("curva_id"):
                        cmd["curva_id"] = est.curva_atual
                    motor.comanda(cmd)
        except WebSocketDisconnect:
            pass
        finally:
            tarefa.cancel()
            motor.desassina(a)

    rotas = [
        Route("/", raiz),
        Route("/api/observaveis", api_observaveis),
        Route("/api/estado", api_estado),
        Route("/api/kits", api_kits),
        Route("/api/sessao", api_sessao, methods=["POST"]),
        Route("/api/sessao/encerrar", api_sessao, methods=["POST"]),
        Route("/api/curvas", api_curvas),
        Route("/api/curva", api_curva_nova, methods=["POST"]),
        Route("/api/curva/{cid:int}", api_curva_pontos),
        Route("/api/curva/{cid:int}/definicao", api_curva_definicao,
              methods=["POST"]),
        Route("/api/curva/{cid:int}/ajustar", api_curva_ajustar, methods=["POST"]),
        Route("/api/curva/{cid:int}/inversa", api_curva_inversa, methods=["POST"]),
        Route("/api/curva/{cid:int}/csv", api_curva_csv),
        Route("/api/curva/{cid:int}/r2", api_r2),
        Route("/api/ponto", api_curva_ponto_editar, methods=["POST"]),
        Route("/api/planejar", api_planejar, methods=["POST"]),
        Route("/api/cal/resolver", api_cal_resolver, methods=["POST"]),
        Route("/api/cal/aplicar", api_cal_aplicar, methods=["POST"]),
        Route("/api/cal/reverificar", api_cal_reverificar, methods=["POST"]),
        Route("/api/exportar", api_exportar, methods=["POST"]),
        WebSocketRoute("/ws", ws),
        # A montagem fica na RAIZ, e não em `/estatico`, para o mesmo
        # `index.html` servir nos dois modos: no GitHub Pages a página mora
        # numa subpasta, e um caminho absoluto como `/estatico/js/app.js`
        # apontaria para fora do site. Ela vem por último: `/api/...` e `/ws`
        # casam antes.
        Mount("/", EstaticosSemCache(directory=WEB), name="estatico"),
    ]

    # O Starlette 1.x não tem mais `on_event`; o ciclo de vida é um
    # gerenciador de contexto.
    @contextlib.asynccontextmanager
    async def ciclo(app):
        motor.inicia(asyncio.get_running_loop())
        motor.comanda(dict(t="modo", modo="varredura"))
        try:
            yield
        finally:
            motor.encerra()
            est.gravadora.encerra()

    app = Starlette(routes=rotas, lifespan=ciclo)
    app.state.mw = est
    return app


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mwflow.servidor",
                                 description="Servidor local do MWFlow.")
    ap.add_argument("--porta-http", type=int, default=8765)
    ap.add_argument("--porta", default=None, help="porta serial do VNA")
    ap.add_argument("--simulado", action="store_true",
                    help="bancada simulada, sem hardware")
    ap.add_argument("--dut", default="ressoador")
    ap.add_argument("--turbo", action="store_true")
    a = ap.parse_args(argv)

    if a.simulado:
        motor = Motor(simulado=True, dut=a.dut, turbo=a.turbo)
    else:
        from mwflow.vna.litevna import LiteVNA
        motor = Motor(dispositivo=LiteVNA(a.porta))

    app = cria_app(motor)
    print("MWFlow em http://127.0.0.1:%d   (%s)"
          % (a.porta_http, "SIMULADO" if a.simulado else "LiteVNA64"))
    uvicorn.run(app, host="127.0.0.1", port=a.porta_http, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
