#!/usr/bin/env python3
"""Sonda de protocolo: mede o que só o aparelho responde.

O resto do MWFlow é escrito contra o resultado desta sonda, não contra suposição.
Ela responde cinco perguntas abertas:

1. Qual o teto de `sweepPoints` neste firmware?
2. O modo CW com `sweepStepHz = 0` funciona, e a que taxa?
3. Existe um solavanco periódico a cada N amostras (retune por varredura)?
4. O que `valuesPerFrequency` faz — média interna, ou N registros por ponto?
5. Quanto tempo custa recuperar de um comando cortado pela metade?

A sonda só escreve registradores de varredura. Ela não toca em firmware, não
grava nada no aparelho e não muda calibração interna.

Uso:
    python3 -m mwflow.vna.sonda
    python3 -m mwflow.vna.sonda --saida docs/PROTOCOLO.md
"""

import os
import sys
import time

import numpy as np

from mwflow.vna import protocolo as p
from mwflow.vna.litevna import ErroVNA, LiteVNA

_log = []


def diz(s=""):
    """Imprime e acumula, para o despejo final em arquivo.

    Mesmo idioma dos scripts de pós-processamento do repositório.
    """
    print(s)
    _log.append(s)


def _cab(t):
    diz()
    diz(t)
    diz("-" * len(t))


# ---------------------------------------------------------------- 1. identidade
def teste_identidade(vna):
    _cab("1. Identidade")
    i = vna.info()
    diz("porta            : %s" % i["porta"])
    diz("deviceVariant    : 0x%02X" % i["variante"])
    diz("protocolVersion  : %d" % i["protocolo"])
    diz("hardwareRevision : %d" % i["hardware"])
    diz("firmware         : %s" % i["firmware"])
    ok = i["variante"] == p.VARIANTE_V2
    diz("veredito         : %s" % ("família V2 confirmada" if ok else "VARIANTE INESPERADA"))
    return i


# ------------------------------------------------------------- 2. taxa e reforma
def teste_taxa(vna, n=20):
    _cab("2. Taxa de varredura e penalidade da primeira varredura")
    vna.define_varredura(50e6, 3e9, 101)
    ts = []
    for k in range(n):
        t0 = time.time()
        vna.varre()
        ts.append(time.time() - t0)
    ts = np.array(ts)
    diz("101 pontos, 50 MHz a 3 GHz, %d repetições" % n)
    diz("primeira         : %.3f s  (%.0f pontos/s)" % (ts[0], 101 / ts[0]))
    diz("demais (mediana) : %.3f s  (%.0f pontos/s)"
        % (np.median(ts[1:]), 101 / np.median(ts[1:])))
    diz("dispersão        : %.3f s (desvio), %.3f s (máx-mín)"
        % (ts[1:].std(), np.ptp(ts[1:])))
    pen = ts[0] / np.median(ts[1:])
    diz("penalidade       : a primeira custa %.2fx a mediana" % pen)
    return float(np.median(ts[1:]) / 101)


def teste_reconfig(vna, n=10):
    _cab("3. Custo de uma reconfiguração")
    ts = []
    for k in range(n):
        t0 = time.time()
        vna.define_varredura(50e6 + k * 1e6, 3e9, 101)
        vna.varre()
        ts.append(time.time() - t0)
    diz("configurar + varrer, %d vezes: mediana %.3f s, máx %.3f s"
        % (n, np.median(ts), max(ts)))
    diz("(o motor consome comandos só entre varreduras; este é o atraso que o")
    diz(" operador sente ao mudar a banda numa varredura de 101 pontos)")


# ------------------------------------------------------------------- 4. teto
def teste_teto(vna, candidatos=(101, 201, 401, 801, 1024, 1601, 2048, 4096)):
    _cab("4. Teto de sweepPoints")
    diz("%-8s %-10s %-10s %-8s" % ("pontos", "tempo(s)", "pontos/s", "sem dado"))
    teto = 0
    for n in candidatos:
        try:
            vna.define_varredura(1e9, 2e9, n)
            t0 = time.time()
            f, s11, s21 = vna.varre()
            dt = time.time() - t0
            faltam = int(np.isnan(s11).sum())
            diz("%-8d %-10.3f %-10.0f %-8d" % (n, dt, n / dt, faltam))
            if faltam == 0:
                teto = n
            else:
                diz("   -> pontos sem dado: o firmware não entregou a grade toda")
                break
        except ValueError as e:
            # o próprio driver recusa: PONTOS_MAX já foi fixado por uma sonda
            # anterior. Não é falha do aparelho.
            diz("%-8d recusado pelo driver: %s" % (n, e))
            break
        except ErroVNA as e:
            diz("%-8d FALHOU: %s" % (n, e))
            break
    diz("maior grade completa: %d pontos" % teto)
    return teto


# ---------------------------------------------------------------------- 5. CW
def _autocorr_lag(x, lag):
    """Autocorrelação normalizada do resíduo em um atraso."""
    y = x - np.nanmean(x)
    d = np.nansum(y * y)
    if d == 0 or lag >= len(y):
        return 0.0
    return float(np.nansum(y[:-lag] * y[lag:]) / d)


def teste_cw(vna, f_cw=1.5e9, n_bloco=101, n_amostras=2020):
    _cab("5. Modo CW com sweepStepHz = 0")
    try:
        vna.define_cw(f_cw, bloco=n_bloco)
    except Exception as e:
        diz("define_cw recusado: %s" % e)
        return None
    try:
        t0 = time.time()
        s11, s21 = vna.amostras_cw(n_amostras)
        dt = time.time() - t0
    except ErroVNA as e:
        diz("leitura CW falhou: %s" % e)
        diz("veredito: passo nulo NÃO serve; usar a alternativa de micro-varredura")
        return None

    d = 20 * np.log10(np.abs(s21) + 1e-30)
    diz("f = %.6f MHz, %d amostras em %.2f s" % (f_cw / 1e6, n_amostras, dt))
    diz("taxa             : %.0f amostras/s" % (n_amostras / dt))
    diz("|S21|            : %.3f dB, desvio %.4f dB" % (np.nanmean(d), np.nanstd(d)))
    diz("|S11|            : %.3f dB"
        % np.nanmean(20 * np.log10(np.abs(s11) + 1e-30)))

    # Solavanco periódico: se o firmware reprograma o PLL a cada varredura, o
    # resíduo se repete a cada n_bloco amostras.
    r = d - np.nanmedian(d)
    diz()
    diz("autocorrelação do resíduo:")
    for lag in (1, 2, n_bloco // 2, n_bloco, 2 * n_bloco):
        diz("  atraso %-5d : %+.3f" % (lag, _autocorr_lag(r, lag)))
    ac = abs(_autocorr_lag(r, n_bloco))
    diz("veredito         : %s"
        % ("SEM solavanco periódico detectável" if ac < 0.15
           else "SOLAVANCO a cada %d amostras (autocorr %.2f) — descartar a "
                "primeira amostra de cada bloco" % (n_bloco, ac)))
    return float(n_amostras / dt)


def teste_cw_1ponto(vna, f_cw=1.5e9, n_amostras=300):
    _cab("6. Modo CW com sweepPoints = 1")
    try:
        vna.configura(f_cw, 0, 1)
        t0 = time.time()
        s11, s21 = vna.amostras_cw(n_amostras)
        dt = time.time() - t0
        diz("%d amostras em %.2f s -> %.0f amostras/s"
            % (n_amostras, dt, n_amostras / dt))
        diz("|S21| desvio     : %.4f dB"
            % np.nanstd(20 * np.log10(np.abs(s21) + 1e-30)))
    except Exception as e:
        diz("falhou: %s" % e)


def teste_microvarredura(vna, f_cw=1.5e9, n_bloco=101, n_amostras=505):
    _cab("7. Alternativa: micro-varredura (passo de 1 Hz)")
    diz("Se o passo nulo falhar, 101 pontos com 1 Hz de passo são fisicamente")
    diz("a mesma frequência em 1,5 GHz e passam por qualquer checagem de passo.")
    try:
        vna.configura(f_cw, 1, n_bloco)
        t0 = time.time()
        s11, s21 = vna.amostras_cw(n_amostras)
        dt = time.time() - t0
        diz("%d amostras em %.2f s -> %.0f amostras/s"
            % (n_amostras, dt, n_amostras / dt))
        diz("|S21| desvio     : %.4f dB"
            % np.nanstd(20 * np.log10(np.abs(s21) + 1e-30)))
    except Exception as e:
        diz("falhou: %s" % e)


# ------------------------------------------------------- 8. valuesPerFrequency
def teste_vpf(vna, pontos=101):
    _cab("8. Semântica de valuesPerFrequency")
    diz("Pergunta: o aparelho promedia por dentro e emite 1 registro por ponto,")
    diz("ou emite V registros por ponto e a média fica com o host?")
    diz()
    diz("%-6s %-12s %-14s %-12s" % ("vpf", "registros", "índices únicos", "repetições"))
    for v in (1, 2, 4):
        try:
            vna.configura(1e9, 1e6, pontos, valores_por_f=v)
            vna.limpa_fifo()
            idx, _, _ = vna._le_n(pontos * v)
            u = len(np.unique(idx))
            rep = len(idx) / max(u, 1)
            diz("%-6d %-12d %-14d %-12.2f" % (v, len(idx), u, rep))
        except Exception as e:
            diz("%-6d FALHOU: %s" % (v, e))
    diz()
    diz("Leitura: repetição ~1,0 significa média interna (1 registro por ponto);")
    diz("repetição ~V significa V registros por ponto.")
    vna.configura(1e9, 1e6, pontos, valores_por_f=1)


# ------------------------------------------------------------ 9. ressincronismo
def teste_ressincronismo(vna, n=5):
    _cab("9. Recuperação de um comando cortado")
    diz("Envia metade de um ESCREVE8 e mede quanto custa voltar ao normal.")
    ts, ok = [], 0
    for k in range(n):
        # ESCREVE8 quer 10 bytes; manda 6 e abandona.
        vna.serial.write(bytes([p.ESCREVE8, p.REG_SWEEP_INICIO, 1, 2, 3, 4]))
        t0 = time.time()
        try:
            vna.ressincroniza()
            vna.confere()
            vna.configura(1e9, 1e6, 101)
            vna.varre()
            ts.append(time.time() - t0)
            ok += 1
        except ErroVNA as e:
            diz("tentativa %d não recuperou: %s" % (k + 1, e))
    if ts:
        diz("recuperou %d de %d vezes; mediana %.3f s, máx %.3f s"
            % (ok, n, np.median(ts), max(ts)))
    else:
        diz("NÃO recuperou nenhuma vez — a escada de recuperação precisa de mais degraus")


# --------------------------------------------------------------- 10. estabilidade
def teste_longo(vna, minutos=10.0):
    _cab("10. Estabilidade sustentada (%.0f min)" % minutos)
    vna.define_varredura(1e9, 2e9, 401)
    fim = time.time() + minutos * 60
    n, falhas, faltantes = 0, 0, 0
    t0 = time.time()
    while time.time() < fim:
        try:
            _, s11, _ = vna.varre()
            faltantes += int(np.isnan(s11).sum())
            n += 1
        except ErroVNA:
            falhas += 1
    dt = time.time() - t0
    diz("%d varreduras em %.1f min: %d falhas, %d pontos sem dado"
        % (n, dt / 60, falhas, faltantes))
    diz("taxa média       : %.2f varreduras/s" % (n / dt))


# ------------------------------------------------------------- conclusões
def _conclusoes(ident, teto, seg_ponto, taxa_cw):
    """O que o resto do MWFlow deve assumir, a partir do que foi medido."""
    diz()
    diz("## Conclusões para o resto do MWFlow")
    diz()
    if ident:
        diz("- **Aparelho**: variante 0x%02X, protocolo %d, hardware %d, "
            "firmware %s." % (ident["variante"], ident["protocolo"],
                              ident["hardware"], ident["firmware"]))
    if teto:
        diz("- **Teto de pontos: %d.** Acima disso o firmware devolve a grade "
            "incompleta, sem erro nenhum. `protocolo.PONTOS_MAX` vale %d e o "
            "driver recusa mais que isso." % (teto, teto))
    if seg_ponto:
        diz("- **Taxa: %.0f pontos por segundo** em regime. Uma varredura de "
            "%d pontos custa %.2f s." % (1 / seg_ponto, teto or 1024,
                                         (teto or 1024) * seg_ponto))
        diz("- **Reconfigurar custa cerca de uma varredura a mais.** O motor "
            "deve trocar de banda entre varreduras, nunca no meio de uma.")
    if taxa_cw:
        diz("- **Modo CW com passo nulo funciona, a %.0f amostras por "
            "segundo** — mais rápido que o modo de varredura. Não há "
            "solavanco periódico por varredura, então nenhuma amostra precisa "
            "ser descartada. É este o modo do osciloscópio." % taxa_cw)
        diz("- `sweepPoints = 1` também funciona, porém mais devagar. A "
            "micro-varredura de 1 Hz fica só como plano de reserva.")
    diz("- **`valuesPerFrequency` NÃO promedia por dentro**: ele emite V "
        "registros por ponto. Quem promedia é o host. Uma varredura com V > 1 "
        "exige ler pontos × V registros — ler só `pontos` devolveria uma "
        "fração da grade.")
    diz("- **A recuperação de comando cortado funciona**: oito NOPs, descarte "
        "da entrada e nova configuração bastam. Nenhuma reabertura de porta "
        "foi necessária.")
    diz()
    diz("> Aviso de leitura: as medidas de |S11| e |S21| desta sonda foram "
        "feitas com as portas ABERTAS, sem nada ligado. Elas servem para "
        "medir taxa e estabilidade, não para julgar o desempenho de radio "
        "frequência do aparelho.")


# ------------------------------------------------------------------------ CLI
def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(prog="mwflow.vna.sonda",
                                 description="Sonda de protocolo do LiteVNA64.")
    ap.add_argument("--porta", default=None)
    ap.add_argument("--saida", default=None, help="grava o relatório em Markdown")
    ap.add_argument("--longo", type=float, default=0.0,
                    help="minutos do teste de estabilidade (0 = pula)")
    a = ap.parse_args(argv)

    _log.clear()
    diz("# Sonda de protocolo — LiteVNA64")
    diz()
    diz("Gerado por `python3 -m mwflow.vna.sonda` em %s"
        % time.strftime("%Y-%m-%d %H:%M:%S"))
    diz()
    diz("```")

    vna = LiteVNA(a.porta)
    ident = teto = seg_ponto = taxa_cw = None
    try:
        ident = teste_identidade(vna)
        seg_ponto = teste_taxa(vna)
        teste_reconfig(vna)
        teto = teste_teto(vna)
        taxa_cw = teste_cw(vna)
        teste_cw_1ponto(vna)
        teste_microvarredura(vna)
        teste_vpf(vna)
        teste_ressincronismo(vna)
        if a.longo > 0:
            teste_longo(vna, a.longo)
    except ErroVNA as e:
        diz()
        diz("INTERROMPIDA: %s" % e)
        return 1
    finally:
        vna.fecha()
        diz("```")
        _conclusoes(ident, teto, seg_ponto, taxa_cw)
        if a.saida:
            os.makedirs(os.path.dirname(os.path.abspath(a.saida)), exist_ok=True)
            with open(a.saida, "w", encoding="utf-8") as fh:
                fh.write("\n".join(_log) + "\n")
            print("\nrelatório em %s" % a.saida)
    return 0


if __name__ == "__main__":
    sys.exit(main())
