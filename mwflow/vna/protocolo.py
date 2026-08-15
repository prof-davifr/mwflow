"""Protocolo binário do NanoVNA-V2 / LiteVNA.

O LiteVNA64 NÃO fala o shell de texto do NanoVNA-H. Ele usa o protocolo binário
de registradores da família V2. Medido nesta bancada em 2026-08-14: `info\\r`
devolve vazio, e o comando INDICATE (0x0d) devolve 0x32 ('2').

Identificação lida do aparelho:
    deviceVariant 0x02 | protocolVersion 1 | hardwareRevision 2 | firmware 2.2

Formato da FIFO — cada valor ocupa 32 bytes:

    <6i H 6x  =  fwd0(re,im), rev0(re,im), rev1(re,im), freqIndex, reserva

Daí saem os dois parâmetros que este hardware mede:

    S11 = rev0 / fwd0        S21 = rev1 / fwd0

Este módulo só monta e desmonta bytes. Quem abre a porta é `litevna.py`.
"""

import numpy as np

# ---------------------------------------------------------------- comandos
NOP = 0x00
INDICATE = 0x0D
LE1 = 0x10
LE2 = 0x11
LE4 = 0x12
LE_FIFO = 0x18
ESCREVE1 = 0x20
ESCREVE2 = 0x21
ESCREVE4 = 0x22
ESCREVE8 = 0x23
ESCREVE_FIFO = 0x28

# ----------------------------------------------------------- registradores
REG_SWEEP_INICIO = 0x00      # u64, Hz
REG_SWEEP_PASSO = 0x10       # u64, Hz
REG_SWEEP_PONTOS = 0x20      # u16
REG_VALORES_POR_F = 0x22     # u16
REG_FIFO = 0x30

REG_VARIANTE = 0xF0
REG_PROTOCOLO = 0xF1
REG_HARDWARE = 0xF2
REG_FW_MAIOR = 0xF3
REG_FW_MENOR = 0xF4

# -------------------------------------------------------------- constantes
RESPOSTA_INDICATE_V2 = 0x32
VARIANTE_V2 = 0x02

BYTES_POR_VALOR = 32

# A contagem do comando LE_FIFO cabe em UM byte. Acima disso é preciso ler em
# blocos. O driver do ndtmwscanner escrevia `points` direto aqui e quebrava
# silenciosamente acima de 255 pontos.
MAX_POR_LEITURA = 255

# Bloco padrão: 32 valores. Foi o tamanho validado na bancada e mantém a
# latência baixa sem encher o buffer do aparelho.
BLOCO_PADRAO = 32

F_MIN_HZ = 50e3
F_MAX_HZ = 6.3e9

# Teto MEDIDO por `python3 -m mwflow.vna.sonda` em 2026-08-14, não o teto do
# registrador. O registrador é u16, mas com 1601 pontos o firmware devolveu 17
# pontos sem dado; com 1024 devolveu a grade inteira. Ver docs/PROTOCOLO.md §4.
PONTOS_MAX = 1024

# Cada valor de `valores_por_f` gera UM registro na FIFO — o aparelho NÃO
# promedia por dentro. Medido na sonda §8: repetição de índice igual a V para
# V = 1, 2 e 4. Portanto uma varredura com V > 1 tem pontos*V registros, e a
# média é do host.
VPF_EMITE_UM_REGISTRO_POR_VALOR = True

# Estrutura de um registro da FIFO.
DTYPE_FIFO = np.dtype([
    ("fwd_re", "<i4"), ("fwd_im", "<i4"),
    ("rev0_re", "<i4"), ("rev0_im", "<i4"),
    ("rev1_re", "<i4"), ("rev1_im", "<i4"),
    ("idx", "<u2"), ("reserva", "V6"),
])
assert DTYPE_FIFO.itemsize == BYTES_POR_VALOR


# ------------------------------------------------------------------ montagem
def cmd_le(addr, n):
    """Comando de leitura de registrador. `n` em 1, 2 ou 4 bytes."""
    return bytes([{1: LE1, 2: LE2, 4: LE4}[n], addr])


def cmd_escreve(addr, valor, n):
    """Comando de escrita de registrador. `n` em 1, 2, 4 ou 8 bytes."""
    op = {1: ESCREVE1, 2: ESCREVE2, 4: ESCREVE4, 8: ESCREVE8}[n]
    return bytes([op, addr]) + int(valor).to_bytes(n, "little")


def cmd_limpa_fifo():
    """Zera a FIFO de valores. Escrever qualquer coisa em 0x30 limpa."""
    return bytes([ESCREVE1, REG_FIFO, 0x00])


def cmd_le_fifo(n):
    """Lê `n` valores da FIFO. `n` não pode passar de MAX_POR_LEITURA."""
    if not 1 <= n <= MAX_POR_LEITURA:
        raise ValueError("bloco de %d fora de 1..%d" % (n, MAX_POR_LEITURA))
    return bytes([LE_FIFO, REG_FIFO, n])


def cmd_sincroniza():
    """Oito NOPs. Tira o aparelho de um estado meio-comando após um erro."""
    return bytes([NOP]) * 8


def cmd_varredura(inicio_hz, passo_hz, pontos, valores_por_f=1):
    """Todos os registradores de varredura em uma escrita só."""
    return (cmd_escreve(REG_SWEEP_INICIO, int(inicio_hz), 8)
            + cmd_escreve(REG_SWEEP_PASSO, int(passo_hz), 8)
            + cmd_escreve(REG_SWEEP_PONTOS, int(pontos), 2)
            + cmd_escreve(REG_VALORES_POR_F, int(valores_por_f), 2))


# --------------------------------------------------------------- desmontagem
def analisa_fifo(buf):
    """Desmonta um bloco cru da FIFO.

    Devolve (idx, s11, s21) com `idx` inteiro e os dois parâmetros complexos.
    A divisão por fwd0 é a normalização de referência do próprio aparelho: ela
    remove a variação de potência do gerador com a frequência.
    """
    n, resto = divmod(len(buf), BYTES_POR_VALOR)
    if resto:
        raise ValueError("bloco de %d bytes não é múltiplo de %d"
                         % (len(buf), BYTES_POR_VALOR))
    r = np.frombuffer(buf, dtype=DTYPE_FIFO, count=n)

    fwd = r["fwd_re"].astype(np.float64) + 1j * r["fwd_im"]
    rev0 = r["rev0_re"].astype(np.float64) + 1j * r["rev0_im"]
    rev1 = r["rev1_re"].astype(np.float64) + 1j * r["rev1_im"]

    # fwd0 nulo significa referência perdida naquele ponto. Marca como NaN em
    # vez de estourar; o resto da varredura continua válido.
    mau = (fwd == 0)
    if mau.any():
        fwd = fwd.copy()
        fwd[mau] = np.nan

    return r["idx"].astype(np.int64), rev0 / fwd, rev1 / fwd


def grade(inicio_hz, passo_hz, pontos):
    """Grade de frequências da varredura, em Hz."""
    return inicio_hz + passo_hz * np.arange(pontos, dtype=np.float64)


def passo_de(inicio_hz, fim_hz, pontos):
    """Passo inteiro em Hz. O registrador é u64: o passo tem de ser inteiro."""
    if pontos < 2:
        return 0
    return int(round((fim_hz - inicio_hz) / (pontos - 1)))
