# MWFlow — notas para quem for mexer

Leia o `README.md` primeiro. Este arquivo só registra o que morde.

## Verdades do aparelho que custaram uma medida cada

Todas estão em `docs/PROTOCOLO.md`, gerado por `python3 -m mwflow.vna.sonda`.
**Rode a sonda de novo antes de supor um limite novo.**

- **Teto de 1024 pontos.** Com 1601 o firmware devolve a grade incompleta e
  **não avisa**. `protocolo.PONTOS_MAX` guarda isso.
- **`valuesPerFrequency` não promedia por dentro.** Ele emite V registros por
  ponto. Ler só `pontos` registros com V > 1 devolve uma fração da varredura —
  em silêncio.
- **`LE_FIFO` tem contagem de 1 byte.** Acima de 255 valores é obrigatório ler
  em blocos. O driver de onde este veio não fazia isso.
- **Ler os registradores de varredura devolve zero** até o host escrever. Não é
  falha. O estado mora no driver, não no aparelho.
- **O ModemManager está ativo** e marca a porta como candidata. Ele sonda
  CDC-ACM com comandos AT, que caem no interpretador binário do LiteVNA. Daí a
  ressincronização obrigatória na abertura e o `ID_MM_DEVICE_IGNORE` na regra
  udev.
- **A regra udev tem de ficar em 70**, não em 99: o builtin que aplica a
  etiqueta `uaccess` roda em `73-seat-late.rules`.

## Armadilhas do ambiente

- **O `fastapi` global está quebrado** (falta `fastapi/applications.py`).
  O MWFlow usa Starlette. Não tente consertar o fastapi para usar aqui.
- **Starlette 1.x não tem `on_event`.** O ciclo de vida é o `lifespan`.
- **`ndarray.ptp()` saiu no numpy 2.** Use `np.ptp(x)`.
- **uPlot quebra se uma SÉRIE inteira for `null`** — ele lê `.length` dela. Um
  `null` DENTRO do vetor é aceito. Use `MW.vazio(n)`.
- **O uPlot não mede a largura do eixo vertical.** O padrão são 50 px, e
  "1.540,90212" não cabe: o número sai cortado. O `MW.eixo` calcula o tamanho
  pelo maior rótulo, e por isso todo eixo tem de nascer dele.
- **O uPlot pinta numa microtarefa.** Medir a tinta do canvas na mesma
  expressão que chamou `setData` ou `redraw` devolve zero, e não é defeito.
- **`np.full_like(f, valor_complexo)`** com `f` real descarta a parte
  imaginária, calado. Use `np.full(f.shape, valor)`.

## Invariantes do motor

Quebrar qualquer uma destas é um defeito, não uma escolha:

1. A thread de aquisição só chama `call_soon_threadsafe` do asyncio.
2. A thread de aquisição nunca bloqueia numa fila sem prazo.
3. O laço de eventos nunca toca no objeto do driver.
4. Toda leitura da serial tem prazo.
5. Comando de reconfiguração só é consumido **entre** aquisições completas.
   Uma varredura abortada é descartada inteira — entregar meia varredura
   corromperia o ajuste em silêncio.

E mais duas, da calibração:

6. Os padrões SOLT são medidos **sem** correção. Aplicar a calibração velha em
   cima deles produziria calibração encadeada, que é lixo.
7. No disco vai o **bruto**. A correção é da leitura.

## A versão de navegador (`mwflow/web/js/nucleo/`)

O mesmo instrumento existe duas vezes: em Python e em JavaScript. **Toda
mudança de comportamento tem de entrar nos dois no mesmo commit**, e o
`node testes/paridade.mjs` é quem cobra. O Python é a verdade.

O que morde deste lado:

- **`const` no topo de um script clássico NÃO vira propriedade de `window`.**
  Os módulos do núcleo alcançam o MW porque o `util.js` faz a ponte explícita.
  Sem ela o módulo falha com "Cannot set properties of undefined".
- **Nenhuma tela chama `fetch` direto.** Toda rota passa por `MW.api`. No modo
  servidor ela É o fetch; no modo local é o roteador do `local.js`. Um `fetch`
  esquecido funciona na bancada e quebra na página publicada.
- **O marcador `<!--MODO-->` do `index.html`** é o que separa os dois modos. O
  servidor em Python o troca por uma declaração de modo, e o núcleo local se
  desliga. Se ele sumir do HTML, dois motores disputam a mesma porta serial.
- **A montagem de estáticos fica na raiz**, não em `/estatico`: no GitHub Pages
  o site mora numa subpasta e um caminho absoluto aponta para fora dele.
- **`json.dump` do Python escreve `NaN` cru**, e o `JSON.parse` do navegador
  recusa. O `testes/vetores.py` limpa antes de gravar.
- **Ler de volta um arquivo CRLF em modo texto traduz para LF.** Ao comparar o
  CSV nativo byte a byte, abra com `newline=""`.
- **O WebSerial só existe no Chrome, no Edge e no Opera de desktop**, só em
  HTTPS ou `localhost`, e o `requestPort()` só funciona dentro de um clique.
  Nada disso tem contorno; a interface tem de dizer isso ao usuário.
- **As constantes do ressoador simulado são genéricas de propósito**, nos dois
  lados. As da bancada real ficam só em `vna/bancada.py`, que não é publicado.
  Ver a seção de sigilo, mais abaixo.

## A tela de curva

- **Nenhuma grandeza é fixa nela.** O X e a covariável são nomeados pelo
  operador, e TODO rótulo sai de `def()` em `tela_curva.js`. Ao acrescentar um
  campo, pegue o nome de lá — nunca escreva "temperatura" na interface.
- **O tipo de ajuste `termico` virou `covariavel`**, e `cv.canon()` traduz o
  nome velho nos dois lados. As curvas gravadas antes disso têm o X no campo
  `analito` e a covariável em `pontos_curva.temperatura_c`; `descreve_curva()`
  no servidor e `descreveCurva()` no `local.js` são o que as mantém em pé.
- **`a["cov"]` é a matriz de covariância do ajuste**, e não a covariável. A
  lista de valores da covariável chama-se `cov_pontos`. Trocar os dois derruba
  a previsão inversa — já derrubou uma vez.
- **Os eixos da curva usam `MW.eixo(rotulo, "auto")`**: as casas decimais saem
  do espaçamento dos traços. Casas fixas erram nos dois sentidos — com um eixo
  de 1500,281 a 1500,289 MHz, três casas fazem todos os rótulos saírem iguais.
- **A escala do Y da curva abre para a barra de erro** (`MW.faixa`), que é
  desenhada por fora das séries e o uPlot não conhece. A do resíduo inclui o
  zero à força: é contra ele que se lê um resíduo.
- **A dica de um campo e o verbete do manual são o MESMO texto**, em
  `js/manual.js`. Campo novo ganha `data-termo`; termo novo entra em `TERMOS`.
  `MW.manual.orfaos()` lista os `data-termo` sem verbete.
- **Coluna do CSV da curva: `cov`**, com nome fixo de propósito. Um cabeçalho
  que mudasse com a curva quebraria os scripts de análise.
- **Coluna nova no SQLite tem de entrar em `COLUNAS_NOVAS`**
  (`armazenamento.py`). O `CREATE TABLE IF NOT EXISTS` não toca numa tabela que
  já existe: sem a migração, a primeira inserção falha com "no such column"
  numa base gravada antes da mudança.

## Ciência

- **`argmax` é proibido como estimador de f_res.** Com Q ≈ 9 o topo do pico é
  plano e o `argmax` erra 0,3–0,4 MHz contra sinais reais de 2–12 MHz. O
  `mwflow/ajuste.py` é cópia atribuída de
  `sensor-etanol/src/sensor_etanol/ajuste.py` (commit cac3b63). Se precisar
  mexer no estimador, mexa lá e recopie — não divirja em silêncio.
- **A sensibilidade nunca é citada sem a faixa.** O valor muda com ela.
- **σ do limite de detecção tem duas origens**, e a interface diz qual: a
  suposta (1 MHz, para reproduzir os números já publicados) e a **medida** pelo
  osciloscópio. Trocar de origem muda o LOD publicado.
- **Sem calibração, f_res tem viés maior que o sinal.** No simulador o viés é
  de +6,5 MHz contra deslocamentos reais de 2 a 12 MHz. O atraso de cabo mete
  uma fase linear que o modelo de 1 polo não tem.
- **O termo `e22` é inobservável** neste hardware e enviesa f_res e Q.
  Um atenuador de 10 dB na porta 2 reduz o viés em 16 vezes. Ver README.

## Sigilo

O sensor de etanol aguarda depósito no INPI. O MWFlow roda só local: sem CDN,
sem telemetria, sem chamada externa. Dado simulado carrega o rótulo `simulado`
até o disco.

**Este repositório é público** (`prof-davifr/mwflow`, publicado no GitHub
Pages). Nenhum número medido do sensor pode entrar nele. Os quatro que existiam
— f0, Q, IL e o ruído rms do ressoador real, de `relatorios/s049/metrics.json`
do sensor-etanol — moram hoje em `mwflow/vna/bancada.py`, que está no
`.gitignore`. O `simulador.py` o importa se ele existir e cai em valores
genéricos (1,5 GHz, Q = 10, IL = −30 dB) quando não existe; são os mesmos do
`porta_simulada.js`. Sem o arquivo nada quebra: muda só qual ressoador o
simulador imita.

Fora do controle de versão pelo mesmo motivo: `testes/_vetores.json` (gerado, e
gerado NA BANCADA ele carrega o f0 real), `sessoes/`, `cals/` e `*.db`.

**Antes de commitar qualquer coisa nova, olhe se ela carrega número medido do
sensor** — inclusive em comentário e em dado de teste.

## Antes de commitar

O MWFlow é repositório próprio, mas a pasta vive dentro do monorepo de
pesquisa. Nunca `git add -A` estando na raiz do monorepo (≈43 GB de dados de
simulação não rastreados). `sessoes/`, `cals/`, `*.db`, `*.npz`,
`mwflow/vna/bancada.py` e `testes/_vetores.json` já estão no `.gitignore`.
