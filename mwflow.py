#!/usr/bin/env python3
"""Entrada do MWFlow.

    python3 mwflow.py                 # com o LiteVNA64 ligado
    python3 mwflow.py --simulado      # bancada simulada, sem hardware
    python3 mwflow.py --simulado --dut carga --turbo
"""

import sys

from mwflow.servidor import main

if __name__ == "__main__":
    sys.exit(main())
