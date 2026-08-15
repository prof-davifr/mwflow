# MWFlow

Software de bancada, no navegador, para o LiteVNA64. Ele parametriza o aparelho,
calibra, mede sem parar e liga a grandeza medida a uma grandeza conhecida — a
concentração de um analito, a salinidade, a pressão, o que o experimento pedir.

Cinco telas: varredura, osciloscópio, espectrograma, curva de calibração do
sensor e calibração SOLT.

**Existem duas versões, e elas medem igual.** A de Python roda um servidor
local; a de navegador não roda servidor nenhum e fala com o aparelho pela porta
USB. As duas dividem as mesmas cinco telas e o mesmo estimador, e um teste de
paridade cobra 55 casos de concordância entre elas.

## Começar

O passo a passo completo para uma máquina nova, no Linux e no Windows, está
**dentro do programa**: tela *Curva de calibração*, botão **Manual**. Ele vale
também na página publicada — <https://prof-davifr.github.io/mwflow/> —, antes
de instalar qualquer coisa. O resumo:

Sem instalar nada, no Chrome, no Edge ou no Opera de desktop:

1. Abra <https://prof-davifr.github.io/mwflow/>.
2. Clique em **Ligar o LiteVNA64 pela porta USB**, ou em **Abrir a bancada
   simulada** para ver o programa funcionar sem aparelho.

Com o servidor em Python, que é a versão da bancada:

```bash
python3 -m venv .venv               # Windows: py -m venv .venv
source .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python3 mwflow.py                # com o LiteVNA64 ligado
python3 mwflow.py --simulado     # bancada simulada, sem hardware nenhum
```

Depois abra `http://127.0.0.1:8765`.

No Windows não há driver para instalar: o LiteVNA64 aparece como porta COM no
Windows 10 e no 11. No Linux, instale a regra udev uma vez, para a porta ficar
acessível sem `sudo`:

```bash
sudo cp 70-litevna.rules /etc/udev/rules.d/
sudo rm -f /etc/udev/rules.d/99-litevna.rules
sudo udevadm control --reload && sudo udevadm trigger
```

Desconecte e reconecte o cabo USB depois disso. A porta deve ficar `crw-rw-rw-`.

Confira a instalação com:

```bash
python3 -c "import numpy, scipy, serial, starlette, uvicorn; print('ok')"
```

## A versão de navegador

Ela existe para quem tem um LiteVNA64 e não quer instalar Python. A página é
estática: o navegador a baixa uma vez e depois roda tudo na máquina de quem
abriu — driver, ajuste de 1 polo, SOLT, curva de calibração e gravação. Nada é
enviado para servidor nenhum, e não há de onde enviar.

O que ela pede do navegador, e não tem contorno:

| Exigência | Motivo |
|---|---|
| Chrome, Edge ou Opera de **desktop** | o WebSerial não existe no Firefox nem no Safari |
| HTTPS ou `localhost` | o navegador só libera a porta serial nessas duas condições |
| um clique para abrir a porta | `requestPort()` só funciona dentro de um gesto do usuário |
| no Linux, o usuário no grupo `dialout` | ou a regra udev deste repositório |

**A gravação vai para o IndexedDB do navegador, e não para arquivo.** Uma
página estática não escreve em disco sozinha. As tabelas são as mesmas do
SQLite, com os mesmos nomes; o CSV nativo do LiteVNA, o Touchstone e o npz saem
pelo botão de exportar, e o npz sai legível pelo `numpy.load` sem adaptação.
Limpar os dados do site apaga as sessões — antes de fazer isso, exporte.

O que **não** muda entre as duas versões: o modelo de 1 polo, os portões de
sanidade, o SOLT de três termos com resposta melhorada, o colchete de
calibração e a regra de gravar sempre o dado bruto.

### Paridade com o Python — 55 casos

```bash
python3 -m testes.vetores     # o Python despeja entradas e saídas
node testes/paridade.mjs      # o JavaScript tem de reproduzi-las
```

O Python é a verdade: foi ele que produziu os números medidos nesta bancada.
Onde as duas implementações fazem a mesma conta, a exigência é precisão de
máquina; o CSV nativo sai **idêntico byte a byte** e o texto do resumo da curva
também. Onde os algoritmos diferem por natureza, a exigência é física e está
escrita ao lado do caso:

- **O otimizador do ajuste.** O Python usa o lmdif do MINPACK; o navegador usa
  um Levenberg-Marquardt próprio. Cobra-se o mesmo mínimo (custo igual em 1e-9
  relativo), não o mesmo caminho até ele. A diferença medida em f_res é de
  0,4 Hz no caso ideal e 64 Hz no caso com caixa de erro — contra deslocamentos
  reais de 2,7 a 12 MHz. Nos dois casos o JavaScript parou num mínimo igual ou
  ligeiramente melhor.
- **O Monte Carlo da previsão inversa.** O gerador do numpy não é o do
  navegador. A barra de incerteza difere 0,2 %, e o campo `metodo` da resposta
  diz qual ramo produziu o número.

## As telas

| Tela | O que faz |
|---|---|
| **Varredura** | S11 e S21 ao vivo, em dB, fase, VSWR, R+jX ou atraso de grupo. O **modelo ajustado** aparece por cima dos dados e a banda do ajuste fica sombreada: quando o ajuste está ruim, você vê na hora. |
| **Osciloscópio** | A grandeza escolhida contra o tempo. Mostra média, desvio, pico a pico, deriva por minuto e **σ de 60 s** — o número que substitui a precisão suposta no cálculo do limite de detecção. |
| **Espectrograma** | Magnitude contra frequência e tempo, em canvas próprio com buffer em anel. |
| **Curva de calibração** | Y medido contra X digitado, com **qualquer grandeza**: você digita o nome e a unidade do X e da covariável. Ajuste linear, polinomial ou linear com a covariável; R², sensibilidade, LOD, previsão inversa e varredura de R². Traz o manual da tela — instalação, preparo do experimento e glossário — e a mesma definição vira dica de cada campo. |
| **Calibração SOLT** | Aberto, curto, carga, thru e isolamento; resolve, aplica e faz o colchete de início e fim de sessão. |

### Duas escolhas da interface que valem explicação

**A grandeza escolhida define o modo do aparelho.** `f_res` e `Q` saem de um
ajuste sobre uma banda — eles não existem numa frequência só. Escolher `f_res`
no osciloscópio põe o aparelho em varredura (cerca de 3 pontos por segundo);
escolher `|S| (dB)` põe em frequência fixa (cerca de 320 amostras por segundo).
A tela troca sozinha e diz que trocou.

**Nenhuma grandeza é fixa na curva de calibração.** Quem diz o que é o X —
concentração, salinidade, pressão, vazão — e o que é a covariável é o operador,
na própria tela, com nome e unidade. Os eixos, a tabela, os campos da captura e
as mensagens saem daquilo que ele digitou. As curvas gravadas antes disso
continuam válidas: nelas o X é o analito de então e a covariável é a
temperatura em grau Celsius.

**A covariável é campo obrigatório na captura de um ponto**, e a exigência pode
ser desligada por curva. Ela existe porque um ponto sem covariável não entra no
ajuste que a desconta, e a deriva não pode ser corrigida depois. Com um sensor
cuja permissividade tem coeficiente térmico forte — o etanol, por exemplo —
deixar a exigência ligada não é opcional.

## Comandos de linha

```bash
# identificação do aparelho
python3 -m mwflow.vna.litevna --info

# varredura e frequência fixa
python3 -m mwflow.vna.litevna --varre 50e6 3e9 101
python3 -m mwflow.vna.litevna --varre 1e9 2e9 1024 --media 4
python3 -m mwflow.vna.litevna --cw 1.5e9 --n 500

# bancada simulada
python3 -m mwflow.vna.simulador --demo --turbo
python3 -m mwflow.vna.simulador --demo --dut carga

# sonda de protocolo: regenera docs/PROTOCOLO.md
python3 -m mwflow.vna.sonda --saida docs/PROTOCOLO.md
python3 -m mwflow.vna.sonda --saida docs/PROTOCOLO.md --longo 10

# verificações
python3 -m testes.teste_solt              # SOLT sintético, sem hardware
python3 -m testes.teste_ponta_a_ponta     # servidor + WS + banco + curva
python3 -m testes.vetores                 # vetores de referência do Python
node testes/paridade.mjs                  # o navegador tem de reproduzi-los
```

## O que a sonda mediu no aparelho

`docs/PROTOCOLO.md` é gerado pela sonda; nenhum número dele foi digitado à mão.
O resumo, de 2026-08-14:

- Variante 0x02, protocolo 1, hardware 2, firmware 2.2.
- **303 pontos por segundo** em regime. Uma varredura de 1024 pontos custa 3,4 s.
- **Teto de 1024 pontos.** Com 1601 o firmware devolve a grade incompleta e não
  avisa. O driver recusa mais que 1024.
- **`valuesPerFrequency` não promedia por dentro.** Ele emite V registros por
  ponto; quem promedia é o host.
- **Modo CW com passo nulo funciona, a 322 amostras por segundo**, sem solavanco
  periódico. É o modo do osciloscópio.
- Recuperação de comando cortado: 5 de 5, em 0,72 s.

## Limites do hardware, ditos em voz alta

O LiteVNA64 **não tem chave de reversão**. Ele mede S11 e S21, e só. S12 e S22
exigem inverter o dispositivo na bancada, e mesmo assim não formam uma
calibração de 12 termos.

A consequência é maior do que parece: o casamento da porta 2 (`e22`) é
**inobservável**, e portanto incorrigível. Num ressoador de transmissão ele não
atrapalha só a amplitude — ele **enviesa f_res e Q**, porque |S22| varia rápido
através da ressonância.

A defesa é física e barata. Medido na bancada simulada
(`python3 -m testes.teste_solt`, seção 8):

| Atenuador na porta 2 | Erro de f_res | Erro de Q |
|---|---:|---:|
| nenhum | −2274 kHz | +5,9 % |
| 6 dB | −774 kHz | +2,9 % |
| **10 dB** | **−142 kHz** | **+3,0 %** |

**Recomendação: deixe um atenuador de 10 dB fixo na porta 2.** Ele custa 10 dB
de faixa dinâmica, que aqui sobra, e reduz o viés de f_res em dezesseis vezes.

## Gravação

Três formatos, três razões:

- **SQLite** (`mwflow.db`) é a verdade. Uma base para todas as sessões, porque
  uma curva de calibração atravessa sessões.
- **CSV nativo do LiteVNA** (`sessoes/<nome>/varreduras/*.csv`) é a ponte: mesmo
  separador, mesma vírgula decimal e as mesmas nove colunas dos dados
  históricos. O `artigo/analise.py` e o `microondas-ph/ph_analise.py` leem uma
  medida nova **sem uma linha de mudança** — isso é verificado byte a byte
  contra um arquivo histórico.
- **Touchstone** `.s1p`/`.s2p` e **npz** com as chaves `f`, `s11`, `s21`, as
  mesmas que `sensor_etanol.ajuste` carrega.

**No disco vai sempre o dado BRUTO.** A calibração é aplicada na leitura. Por
isso trocar de conjunto de calibração, ou de modo do colchete, depois da medida
é sempre possível e nunca destrói medida.

## Colchete de calibração

Uma série gravimétrica leva horas e o aparelho deriva com a temperatura. Uma
calibração só no começo não separa a deriva do instrumento da deriva do sensor.

- **Reverificação**, ao encerrar: remede os padrões e aplica a calibração
  **vigente**. Relata o desvio. Portão: carga corrigida acima de −30 dB reprova
  a sessão.
- **Segunda calibração**, opcional: com dois conjuntos, o modo `interpolado`
  interpola os termos de erro no tempo pelo carimbo de hora de cada varredura, e
  **corrige** a deriva em vez de só medi-la. A hipótese é deriva lenta e
  monótona; se alguém mexeu nos cabos, use o modo `inicial`.

## Estrutura

```
mwflow.py                entrada
mwflow/
├── caminhos.py          raiz do projeto e pastas de dados
├── ajuste.py            cópia atribuída do estimador de 1 polo do sensor-etanol
├── observaveis.py       registro de grandezas + portões de sanidade
├── motor.py             thread dona da serial + difusão asyncio
├── servidor.py          Starlette: rotas e WebSocket binário
├── armazenamento.py     SQLite, CSV nativo, Touchstone, npz
├── curva.py             ajuste, R², sensibilidade, LOD, inversa, planejamento
├── kit_cal.py           modelos dos padrões (offset, C0..C3, L0..L3)
├── solt.py              3 termos de 1 porta, resposta melhorada, interpolação
├── vna/
│   ├── protocolo.py     registradores, comandos e formato da FIFO — sem I/O
│   ├── litevna.py       driver: dono exclusivo da porta serial
│   ├── simulador.py     porta serial FALSA, para rodar o driver sem hardware
│   └── sonda.py         mede o que só o aparelho responde
└── web/                 interface (uPlot vendorizado, sem CDN)
    ├── index.html       a MESMA página nos dois modos
    ├── js/              as cinco telas, iguais nos dois modos
    ├── js/manual.js     manual da curva + as dicas de cada campo, num texto só
    └── js/nucleo/       o MWFlow inteiro em JavaScript, para o navegador
        ├── num.js               o que o numpy e o scipy faziam
        ├── protocolo.js         gêmeo de vna/protocolo.py
        ├── porta_webserial.js   a porta USB do navegador
        ├── porta_simulada.js    gêmeo de vna/simulador.py
        ├── litevna.js           gêmeo de vna/litevna.py
        ├── ajuste.js            gêmeo de ajuste.py (Levenberg-Marquardt)
        ├── observaveis.js       gêmeo de observaveis.py
        ├── kit_cal.js, solt.js  gêmeos de kit_cal.py e solt.py
        ├── curva.js             gêmeo de curva.py
        ├── armazenamento.js     IndexedDB, CSV, Touchstone e npz
        ├── motor.js             gêmeo de motor.py, sem thread
        └── local.js             põe MW.ws e MW.api no lugar do servidor
testes/                  teste_solt.py, teste_ponta_a_ponta.py,
                         vetores.py + paridade.mjs
```

## For readers in English

MWFlow is a bench program for the **LiteVNA64** vector network analyser. It
configures the instrument, runs a SOLT calibration, measures continuously and
turns the measured quantity into a calibration curve against a known
concentration. Resonance frequency and Q come from a complex one-pole fit over
a band, never from `argmax`.

Two builds, one behaviour: a Python server you run locally, and a static page
that talks to the instrument through the browser's **WebSerial** API. A parity
suite (`python3 -m testes.vetores && node testes/paridade.mjs`) checks 55 cases
between them.

Scope and limits, stated up front: the LiteVNA64 has **no reversing switch**.
It measures S11 and S21 only. Port-2 match (`e22`) is unobservable and
therefore uncorrectable; it biases both f_res and Q, not just amplitude. Keep a
fixed 10 dB attenuator on port 2. The interface, the code and the comments are
in Portuguese.

## Convenções

- Português no código, nos comentários e nos documentos.
- Todo número citado num documento sai de um script. Quando um número parece
  errado, rode o script de novo em vez de editar o texto.
- `f_res` nunca sai de `argmax`. Ela sai do ajuste complexo de 1 polo em
  `mwflow/ajuste.py`. O motivo está no cabeçalho daquele arquivo.
- Dado simulado carrega o rótulo `simulado` até o disco. Ele não pode virar
  número de artigo por engano.
- O MWFlow roda só na máquina local: sem CDN, sem telemetria, sem chamada
  externa. O uPlot está em `mwflow/web/vendor/` (versão 1.6.32,
  `sha256 19c8d4c6ad88929a79f4ae49d6f7161566dfd0ba3d15cc495e974f787eb78f1f`).
