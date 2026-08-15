#!/usr/bin/env python3
"""Verificação sintética do SOLT. Não precisa de hardware.

A lógica: monta-se uma caixa de erro CONHECIDA, sintetizam-se as medidas dos
padrões com um kit NÃO ideal, resolve-se, e exige-se de volta a verdade. Depois
corrige-se um quarto dispositivo que não participou da solução — é ele que
prova que a calibração funciona, e não que a álgebra fecha consigo mesma.

    python3 -m testes.teste_solt
"""

import sys

import numpy as np

from mwflow import kit_cal, solt

_falhas = []


def exige(cond, texto, valor=""):
    marca = "ok  " if cond else "FALHA"
    print("  [%s] %s %s" % (marca, texto, valor))
    if not cond:
        _falhas.append(texto)


def caixa(f, semente=3):
    rng = np.random.default_rng(semente)
    tau = 1.0e-9
    rot = np.exp(-2j * np.pi * f * tau)
    return dict(
        e00=0.03 * np.exp(2j * np.pi * f / 1.7e9) + 0.004,
        e11=0.12 * rot * np.exp(1j * rng.uniform(0, 0.3)),
        e10e01=0.93 * rot ** 2,
        e22=0.09 * rot,
        e30=10 ** (-85 / 20.0) * np.exp(1j * rng.uniform(0, 2 * np.pi)),
        e10e32=0.88 * rot)


def mede_reflexao(e, ga):
    return e["e00"] + e["e10e01"] * ga / (1 - e["e11"] * ga)


def mede_transmissao(e, s11a, s21a):
    return e["e30"] + e["e10e32"] * s21a / ((1 - e["e11"] * s11a)
                                            * (1 - e["e22"] * s11a))


def principal():
    f = np.linspace(50e6, 6e9, 401)
    kit = kit_cal.carrega_kit("sma_generico")
    e = caixa(f)
    ideais = kit_cal.padroes(f, kit)
    medidos = {k: mede_reflexao(e, v) for k, v in ideais.items()}

    print("\n1. Recuperação dos termos de erro (kit certo)")
    t = solt.resolve_uma_porta(f, medidos, kit)
    for k in ("e00", "e11", "e10e01"):
        err = float(np.max(np.abs(t[k] - e[k])))
        exige(err < 1e-10, "%-8s erro máximo" % k, "%.2e" % err)
    exige(float(np.max(t["cond"])) < 1e3, "número de condição sadio",
          "%.1f" % np.max(t["cond"]))

    print("\n2. Correção de um dispositivo que NÃO entrou na solução")
    for nome, ga in (("carga de 25 ohm",
                      np.full(f.shape, (25 - 50) / (25 + 50) + 0j)),
                     ("curto deslocado 10 mm",
                      -np.exp(-2j * np.pi * f * 2 * 0.010 / 2.0e8)),
                     ("atenuador de 10 dB",
                      np.full(f.shape, 10 ** (-20 / 20.0) + 0j))):
        gm = mede_reflexao(e, ga)
        corr, _ = solt.corrige(t, gm)
        err = float(np.max(np.abs(corr - ga)))
        exige(err < 1e-9, "%-24s erro máximo" % nome, "%.2e" % err)

    print("\n3. Transmissão: resposta melhorada")
    tt = solt.resolve_transmissao(f, mede_transmissao(e, ideais["carga"] * 0,
                                                      kit_cal.s21_thru(f, kit["thru"])),
                                  t["e11"], kit=kit)
    t.update(tt)
    # ressoador de teste
    f0, q = 1.5487e9, 9.5
    L = 1.0 / (1 + 2j * q * (f - f0) / f0)
    s21a = 1e-3 + (10 ** (-29.5 / 20.0) - 1e-3) * L
    s11a = 0.92 - 0.75 * L
    s11m = mede_reflexao(e, s11a)
    s21m = mede_transmissao(e, s11a, s21a)
    c11, c21 = solt.corrige(t, s11m, s21m)
    err21 = float(np.max(np.abs(c21 - s21a)))
    prev = float(np.max(np.abs(e["e22"] * s11a)))
    exige(err21 < 2 * prev, "erro residual do S21 é da ordem de |e22*S22|",
          "%.2e contra %.2e previsto" % (err21, prev))
    print("      -> este resíduo é exatamente o que a falta de chave de reversão")
    print("         deixa para trás. Um atenuador de 10 dB na porta 2 o reduz.")

    print("\n4. Kit errado: resolver com padrões ideais o que foi medido com reais")
    ideal = kit_cal.carrega_kit("ideal")
    t_mau = solt.resolve_uma_porta(f, medidos, ideal)
    corr_mau, _ = solt.corrige(t_mau, mede_reflexao(e, ideais["aberto"]))
    erro_fase = float(np.max(np.abs(np.degrees(
        np.angle(corr_mau / ideais["aberto"])))))
    exige(erro_fase > 1.0, "o kit errado produz erro de fase visível",
          "%.1f graus" % erro_fase)
    print("      -> por isso o kit NÃO pode ser suposto ideal em 6 GHz.")

    print("\n5. Condicionamento: três padrões quase iguais")
    ruins = dict(aberto=medidos["aberto"],
                 curto=medidos["aberto"] * (1 + 1e-6),
                 carga=medidos["aberto"] * (1 + 2e-6))
    t_ruim = solt.resolve_uma_porta(f, ruins, kit)
    exige(float(np.max(t_ruim["cond"])) > solt.COND_LIMITE,
          "o mau condicionamento é denunciado",
          "%.2e" % np.max(t_ruim["cond"]))

    print("\n6. Interpolação de banda")
    f2 = np.linspace(200e6, 5.5e9, 1024)
    ti = solt.interpola(t, f2)
    e2 = caixa(f2)
    err = float(np.max(np.abs(ti["e10e01"] - e2["e10e01"])))
    exige(err < 5e-3, "interpolação fiel dentro da banda", "%.2e" % err)
    try:
        solt.interpola(t, np.linspace(50e6, 7e9, 100))
        exige(False, "extrapolar deveria ser recusado")
    except ValueError:
        exige(True, "extrapolar é recusado")

    print("\n7. Reverificação e mistura no tempo")
    r = solt.reverifica(f, t, medidos, kit)
    exige(r["veredito"] == "aprovado", "reverificação com a própria cal",
          "carga em %.1f dB" % r["carga"]["pior_db"])
    t2 = solt.resolve_uma_porta(f, {k: v * (1 + 0.01) for k, v in medidos.items()}, kit)
    m = solt.mistura_no_tempo(t, t2, 0.5)
    meio = float(np.max(np.abs(m["e00"] - 0.5 * (t["e00"] + t2["e00"]))))
    exige(meio < 0.02, "a mistura no tempo fica entre os dois", "%.2e" % meio)
    d = solt.distancia(t, t2)
    exige(all(np.isfinite(v) for v in d.values()),
          "a distância entre conjuntos é calculável", str({k: round(v, 1) for k, v in d.items()}))

    print("\n8. Quanto um atenuador na porta 2 recupera")
    print("   O termo e22 é inobservável sem chave de reversão, então o SOLT")
    print("   não o corrige. Ele enviesa f_res e Q de um ressoador. A defesa")
    print("   é física. Esta é a medida do ganho, na bancada simulada:")
    print()
    print("   %-10s %-14s %-12s" % ("pad", "erro de f_res", "erro de Q"))
    erros = {}
    for pad in (0.0, 6.0, 10.0):
        erros[pad] = _com_pad(pad)
        print("   %-10s %-14s %-12s"
              % ("%.0f dB" % pad, "%+.0f kHz" % (erros[pad][0] / 1e3),
                 "%+.1f %%" % erros[pad][1]))
    # DUAS VEZES, e não as dezesseis desta bancada: o fator depende de onde f0
    # cai na fase do atraso de cabo, e o ressoador simulado é outro em cada
    # máquina — genérico onde não existe `vna/bancada.py`. O que vale em toda
    # bancada é a direção: o atenuador reduz o viés. O quanto está na tabela
    # acima, que é o número a citar.
    exige(abs(erros[10.0][0]) < abs(erros[0.0][0]) / 2,
          "10 dB de atenuação reduzem o viés de f_res pelo menos à metade",
          "%.0f kHz -> %.0f kHz (%.1f vezes)"
          % (erros[0.0][0] / 1e3, erros[10.0][0] / 1e3,
             abs(erros[0.0][0]) / max(1.0, abs(erros[10.0][0]))))
    print("\n   RECOMENDAÇÃO DE BANCADA: deixe um atenuador de 10 dB fixo na")
    print("   porta 2. Ele custa faixa dinâmica, que aqui sobra.")

    print()
    if _falhas:
        print("FALHOU em %d verificações: %s" % (len(_falhas), "; ".join(_falhas)))
        return 1
    print("Todas as verificações do SOLT passaram.")
    return 0


def _com_pad(pad_db):
    """Calibra e mede o ressoador com um atenuador de `pad_db` na porta 2."""
    from mwflow.ajuste import ajusta
    from mwflow.vna.simulador import F0_PADRAO, Q_PADRAO, abre_simulado

    banda = (1.30e9, 2.00e9)
    kit = kit_cal.carrega_kit("sma_generico")
    vna = abre_simulado(turbo=True, deriva=False, pad_db=pad_db)
    try:
        vna.define_varredura(banda[0], banda[1], 401)
        med = {}
        for nome in ("aberto", "curto", "carga"):
            vna.serial.dut = nome
            acc = [vna.varre() for _ in range(8)]
            med[nome] = np.mean([a[1] for a in acc], axis=0)
        f = acc[0][0]
        t = solt.resolve_uma_porta(f, med, kit)
        vna.serial.dut = "thru"
        thru = np.mean([vna.varre()[2] for _ in range(8)], axis=0)
        t.update(solt.resolve_transmissao(f, thru, t["e11"], kit=kit))
        vna.serial.dut = "ressoador"
        f, s11, s21 = vna.varre()
        _, c21 = solt.corrige(t, s11, s21)
        r = ajusta(f, c21, banda)
        return (r["f0"] - F0_PADRAO, 100 * (r["Q"] - Q_PADRAO) / Q_PADRAO)
    finally:
        vna.fecha()


if __name__ == "__main__":
    sys.exit(principal())
