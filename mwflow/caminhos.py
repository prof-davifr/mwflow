"""Caminhos do projeto — fonte única.

Mesmo padrão de `sensor-etanol/src/sensor_etanol/caminhos.py`: o pacote vive em
`mwflow/`, mas os dados (`sessoes/`, `cals/`, o banco) vivem na raiz. Cada
módulo derivaria a raiz do próprio `__file__` e apontaria para o lugar errado.
Este módulo resolve a raiz uma vez e todo mundo importa daqui.
"""

import os

# mwflow/caminhos.py -> mwflow -> raiz
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PACOTE = os.path.join(RAIZ, "mwflow")
WEB = os.path.join(PACOTE, "web")
VENDOR = os.path.join(WEB, "vendor")

SESSOES = os.path.join(RAIZ, "sessoes")
CALS = os.path.join(RAIZ, "cals")
BANCO = os.path.join(RAIZ, "mwflow.db")

# Link estável do LiteVNA64 desta bancada. O /dev/ttyACM0 muda de número quando
# outro CDC-ACM entra antes dele; o by-id não muda.
PORTA_PADRAO = "/dev/serial/by-id/usb-Black_Sphere_Technologies_CDC-ACM_Demo_DEMO-if00"


def garante(*caminhos):
    """Cria os diretórios que faltam. Devolve o primeiro."""
    for c in caminhos:
        os.makedirs(c, exist_ok=True)
    return caminhos[0] if caminhos else None
