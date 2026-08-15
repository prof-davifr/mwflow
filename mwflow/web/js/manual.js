"use strict";
/* Manual da tela de curva de calibração.
 *
 * UMA DEFINIÇÃO, DOIS LUGARES. Cada termo aparece duas vezes na tela: como
 * dica (`title`) do campo que o usa e como verbete do glossário. O texto mora
 * aqui uma vez só e é aplicado nos dois — duas cópias divergiriam no primeiro
 * conserto, e a dica errada é pior que dica nenhuma.
 *
 * O elo entre o campo e o verbete é o atributo `data-termo` do HTML. Um
 * `data-termo` sem verbete não quebra nada: ele só não ganha dica, e o
 * `MW.manual.orfaos()` os lista para quem estiver conferindo.
 *
 * Nada aqui fala de etanol, de água ou de temperatura como se fossem A
 * grandeza. Quem diz o que é o X e o que é a covariável é o operador, na
 * própria tela; o manual explica o papel de cada campo, não o experimento de
 * um só laboratório.
 */

MW.manual = (function () {

  /* ------------------------------------------------------------- glossário */
  const TERMOS = {
    /* --- a curva e o que ela é ------------------------------------------ */
    "curva": ["Curva de calibração",
      "O conjunto de pontos (X, Y) medidos com o mesmo sensor, na mesma "
      + "montagem, mais o ajuste que os liga. É ela que transforma uma leitura "
      + "do aparelho num valor da grandeza que interessa. Cada curva guarda a "
      + "própria definição: quem é o X, quem é o Y e quem é a covariável."],
    "curva-nova": ["Nova curva",
      "Cria uma curva com a definição que estiver nos campos ao lado. Comece "
      + "uma curva nova sempre que trocar de sensor, de montagem ou de "
      + "grandeza: misturar duas montagens numa curva só produz uma reta "
      + "bonita e um resultado falso."],
    "grandeza-x": ["Grandeza X",
      "O nome da grandeza que VOCÊ prepara e conhece em cada ponto — "
      + "concentração, salinidade, temperatura, pressão, vazão, o que for. "
      + "Digite o nome dela; a tela não supõe nenhuma. O X é a variável "
      + "independente: o erro dele tem de ser desprezível diante do erro de Y, "
      + "senão a inclinação sai enviesada."],
    "unidade-x": ["Unidade de X",
      "A unidade em que você digita o X (%vol, g/L, °C, bar, mL/min). Ela "
      + "aparece na sensibilidade, no limite de detecção e na previsão "
      + "inversa. Trocar de unidade no meio da série estraga a curva: o "
      + "programa não converte nada por você."],
    "grandeza-y": ["Grandeza Y (observável)",
      "O que o aparelho mede em cada ponto. Sai do catálogo de observáveis: "
      + "|S| em dB, fase, VSWR, Re(Z), Im(Z), ou um valor derivado do ajuste "
      + "de 1 polo (f_res, Q, IL). Os derivados exigem uma varredura sobre uma "
      + "banda; eles não existem numa frequência só."],
    "covariavel": ["Covariável",
      "Uma segunda grandeza que você registra em cada ponto sem controlá-la — "
      + "temperatura, umidade, pressão, tensão de alimentação. Digite qual é. "
      + "Ela serve para duas coisas: ver se o resíduo depende dela e, no "
      + "ajuste `linear com a covariável`, descontá-la do resultado."],
    "unidade-cov": ["Unidade da covariável",
      "A unidade em que você digita a covariável. Ela aparece no coeficiente "
      + "da covariável e na frase que diz quanto de X uma unidade dela imita."],
    "cov-exigida": ["Exigir a covariável",
      "Ligada, a tela recusa capturar um ponto sem o valor da covariável. "
      + "Deixe ligada quando a covariável tiver efeito sobre o sensor: um "
      + "ponto sem ela não entra no ajuste com covariável e não pode ser "
      + "corrigido depois. Desligue só quando a covariável for irrelevante "
      + "para o experimento."],

    /* --- captura de um ponto -------------------------------------------- */
    "x": ["X do ponto",
      "O valor da grandeza X da amostra que está no sensor agora. Digite o "
      + "valor preparado, não o valor nominal do rótulo, quando os dois "
      + "diferirem."],
    "cov": ["Valor da covariável",
      "O valor da covariável no instante da medida. Meça-o junto do sensor, "
      + "não no outro canto da bancada."],
    "replica": ["Réplica",
      "A letra que identifica a repetição da série inteira (A, B, C). "
      + "Réplicas são repetições INDEPENDENTES: amostra nova, montagem "
      + "refeita. Medir a mesma amostra cinco vezes seguidas não é réplica, é "
      + "o campo Medidas."],
    "ordem": ["Ordem de execução",
      "A posição deste ponto na sequência real de trabalho. É o que permite "
      + "ver deriva no tempo disfarçada de sensibilidade. O botão Planejar "
      + "série preenche este campo sozinho."],
    "x-ref": ["Referência cruzada",
      "O valor de X medido por outro método, independente deste sensor — "
      + "titulação, densímetro, refratômetro, balança. Ele não entra no "
      + "ajuste; fica guardado para você comparar depois."],
    "n-med": ["Medidas (n)",
      "Quantas leituras o programa junta para formar UM ponto. Ele grava a "
      + "média, o desvio-padrão e as leituras individuais. É desse desvio que "
      + "sai o σ medido, e é por isso que n = 1 empobrece o limite de "
      + "detecção: sem repetição não há desvio."],
    "nota": ["Nota",
      "Texto livre gravado com o ponto. Escreva aqui o que não cabe em número: "
      + "bolha na célula, cabo mexido, amostra trocada."],
    "ponto": ["Capturar ponto",
      "Junta as N medidas, calcula a média e o desvio, e grava o ponto na "
      + "curva. Uma leitura que os portões de sanidade recusam não entra: ela "
      + "é contada como recusa, e a tela diz quantas houve."],

    /* --- planejamento --------------------------------------------------- */
    "plano": ["Planejar série",
      "Monta a lista de trabalho: os níveis de X, as réplicas e um nível de "
      + "referência intercalado, tudo em ORDEM SORTEADA. A ordem aleatória é "
      + "o que separa a resposta ao X da deriva no tempo; os retornos ao nível "
      + "de referência são o que torna a deriva visível. Depois disso, siga a "
      + "lista — a tela mostra o próximo ponto a preparar."],
    "semente": ["Semente",
      "O número que gerou a ordem sorteada. Ele fica gravado para a série ser "
      + "reproduzível. Aviso: o gerador do navegador não é o do Python, então "
      + "a mesma semente dá ordens diferentes nas duas versões."],

    /* --- ajuste --------------------------------------------------------- */
    "ajuste": ["Ajuste",
      "O modelo que liga Y a X. `linear` é o padrão e o único com sentido "
      + "físico simples. `polinomial grau 2 ou 3` serve quando a resposta "
      + "curva de verdade — não use grau alto para melhorar o R² de uma reta "
      + "ruim. `linear com a covariável` ajusta Y = a0 + a1·X + a2·(C − C_ref) "
      + "e desconta o efeito da covariável."],
    "faixa": ["Faixa X",
      "Os limites de X que entram no ajuste. Serve para ajustar só o trecho "
      + "linear de uma resposta que satura. A sensibilidade NUNCA é citada sem "
      + "a faixa: o valor dela muda com a faixa escolhida."],
    "sigma": ["σ de Y",
      "A incerteza de uma leitura de Y, que vira o limite de detecção. "
      + "`medida` combina os desvios das réplicas de cada nível — é o número "
      + "da sua bancada. `assumida` usa o valor que você digitar, para "
      + "reproduzir um resultado publicado. Sem nenhuma das duas, o programa "
      + "cai no resíduo do próprio ajuste e diz isso. Trocar a origem do σ "
      + "muda o limite de detecção que você vai publicar; a tela sempre diz "
      + "qual foi usada."],
    "sensibilidade": ["Sensibilidade (S)",
      "A inclinação da curva, em unidade de Y por unidade de X. Num "
      + "polinômio, ela varia com X, e a tela cita a do centro da faixa. "
      + "Sempre acompanhada da faixa em que foi ajustada."],
    "r2": ["R²",
      "A fração da variação de Y que o modelo explica. Um R² alto não prova "
      + "que o modelo está certo: olhe o gráfico de resíduos antes de "
      + "acreditar nele."],
    "r2-ajustado": ["R² ajustado",
      "O R² penalizado pelo número de coeficientes. É ele que se compara entre "
      + "modelos de graus diferentes — o R² cru sempre sobe quando se "
      + "acrescenta um termo, mesmo que o termo não sirva para nada."],
    "s-yx": ["Erro padrão do ajuste (s_y|x)",
      "O desvio típico dos pontos em torno da curva, na unidade de Y. É a "
      + "dispersão que sobra depois do modelo."],
    "lod": ["LOD — limite de detecção",
      "3·σ_y / |S|, na unidade de X. É o menor X que se distingue do branco. "
      + "Ele depende do σ escolhido, e por isso a origem do σ anda junto."],
    "loq": ["LOQ — limite de quantificação",
      "10·σ_y / |S|, na unidade de X. Abaixo dele dá para dizer que há sinal, "
      + "mas não quanto."],
    "coef-cov": ["Coeficiente da covariável",
      "O a2 do ajuste com covariável, em unidade de Y por unidade da "
      + "covariável. Dividido pela sensibilidade, ele responde a pergunta que "
      + "importa: quanto de X uma unidade da covariável IMITA. Se esse número "
      + "for da ordem do seu sinal, controlar a covariável não é opcional."],
    "cov-ref": ["Valor de referência da covariável",
      "A média da covariável nos pontos ajustados. O ajuste desconta o desvio "
      + "em relação a ela, e é a esse valor que a curva corrigida se refere."],

    /* --- diagnóstico ---------------------------------------------------- */
    "residuo": ["Resíduo",
      "A diferença entre o Y medido e o Y previsto pelo modelo. Contra a ORDEM "
      + "DE EXECUÇÃO, um resíduo com tendência denuncia deriva no tempo. "
      + "Contra a COVARIÁVEL, um resíduo com tendência denuncia que ela "
      + "importa. Resíduo espalhado sem forma é o que se quer ver."],
    "barra-erro": ["Barra de erro",
      "O desvio-padrão das N medidas daquele ponto. Barras que crescem com X "
      + "avisam que o ajuste devia ser ponderado."],
    "inversa": ["Previsão inversa",
      "O caminho de volta: de um Y medido ao vivo para o X, com barra de "
      + "incerteza. Ela RECUSA em vez de inventar quando o Y cai fora da faixa "
      + "calibrada, quando a curva não é monótona ali, ou quando a inclinação "
      + "não difere de zero. Uma previsão bonita fora da faixa é pior do que "
      + "uma recusa."],
    "varredura-r2": ["Varredura de R²",
      "Regride Y contra X em CADA frequência das varreduras gravadas e mostra "
      + "o R² ao longo do espectro. É como se descobre onde o sensor responde, "
      + "em vez de adivinhar a banda. Exige a gravação ligada na hora da "
      + "captura."],
    "excluir": ["Excluir e apagar",
      "A caixa `usar` EXCLUI o ponto do ajuste, e ele continua no banco, "
      + "riscado na tabela. O botão `apagar` o remove de vez. Excluir é o que "
      + "um caderno de laboratório permite; apagar é retoque, e só se faz "
      + "quando o ponto nunca foi uma medida (dedo no teclado, amostra "
      + "errada)."],
    "csv": ["Exportar CSV",
      "Uma linha por ponto, com separador `;` e vírgula decimal. A coluna "
      + "`cov` traz a covariável desta curva, seja ela qual for — o nome da "
      + "coluna é fixo para não quebrar os scripts de análise."],
    "manual": ["Manual",
      "Este texto. Cada campo da tela também mostra a mesma definição quando o "
      + "ponteiro para em cima dele."],
  };

  /* ------------------------------------------ instalação em máquina nova */
  const INSTALACAO = [
    ["Caminho 1 — só o navegador, sem instalar nada",
     ["Vale nos dois sistemas. Use Chrome, Edge ou Opera de <strong>desktop</strong>: "
      + "o Firefox e o Safari não têm WebSerial, e não há contorno.",
      "Abra a página do MWFlow. Ela precisa estar em HTTPS ou em "
      + "<code>localhost</code> — o navegador só libera a porta serial nessas "
      + "duas condições.",
      "Ligue o LiteVNA64 no cabo USB. Um cabo só de carga não tem os fios de "
      + "dados e o aparelho não aparece.",
      "Clique em <strong>Ligar o LiteVNA64 pela porta USB</strong> e escolha a "
      + "porta na janela do navegador. O clique é obrigatório: o navegador não "
      + "abre porta sem gesto do usuário.",
      "Sem aparelho na mão, clique em <strong>Abrir a bancada simulada</strong> "
      + "para conhecer o programa. Todo dado que sair dela leva o rótulo "
      + "<code>simulado</code>.",
      "<strong>No Windows:</strong> o aparelho aparece sozinho como porta COM "
      + "no Windows 10 e no 11. Não há driver para instalar.",
      "<strong>No Linux:</strong> o seu usuário precisa de acesso à porta. "
      + "Rode <code>sudo usermod -aG dialout $USER</code> e entre de novo na "
      + "sessão, ou instale a regra udev do repositório (veja abaixo).",
      "A gravação vai para o IndexedDB do navegador, não para arquivo. Limpar "
      + "os dados do site apaga as sessões: exporte antes."]],

    ["Caminho 2 — o servidor em Python, que é a versão de bancada",
     ["<strong>Instale o Python 3.10 ou mais novo.</strong> No Windows, baixe "
      + "de python.org e marque <em>Add python.exe to PATH</em> na primeira "
      + "tela. No Linux, ele já vem; se faltar, "
      + "<code>sudo apt install python3 python3-venv python3-pip</code>.",
      "<strong>Pegue o MWFlow:</strong> <code>git clone</code> do repositório, "
      + "ou baixe o zip e descompacte.",
      "<strong>Crie um ambiente virtual</strong> dentro da pasta do MWFlow. "
      + "Windows: <code>py -m venv .venv</code> e depois "
      + "<code>.venv\\Scripts\\activate</code>. Linux: "
      + "<code>python3 -m venv .venv</code> e depois "
      + "<code>source .venv/bin/activate</code>.",
      "<strong>Instale as dependências:</strong> "
      + "<code>pip install -r requirements.txt</code>. São cinco: numpy, "
      + "scipy, pyserial, starlette e uvicorn.",
      "<strong>Confira:</strong> <code>python -c \"import numpy, scipy, "
      + "serial, starlette, uvicorn; print('ok')\"</code>.",
      "<strong>Só no Linux, uma vez:</strong> <code>sudo cp 70-litevna.rules "
      + "/etc/udev/rules.d/</code>, depois <code>sudo udevadm control --reload "
      + "&amp;&amp; sudo udevadm trigger</code>. Desconecte e reconecte o cabo. "
      + "A porta tem de ficar <code>crw-rw-rw-</code>. A regra é numerada 70, e "
      + "não 99, por causa da ordem em que o udev aplica a etiqueta de acesso.",
      "<strong>Rode:</strong> <code>python mwflow.py</code> com o aparelho "
      + "ligado, ou <code>python mwflow.py --simulado</code> sem hardware "
      + "nenhum. Abra <code>http://127.0.0.1:8765</code>.",
      "A gravação vai para <code>mwflow.db</code> e para a pasta "
      + "<code>sessoes/</code>, na máquina onde o servidor roda. Nada sai dela: "
      + "o MWFlow não faz chamada externa nenhuma."]],
  ];

  /* ------------------------------------ preparação de um experimento novo */
  const PREPARO = [
    "<strong>Deixe o aparelho aquecer.</strong> Ligue o LiteVNA64 e espere uns "
    + "vinte minutos antes de calibrar. A eletrônica deriva enquanto esquenta, "
    + "e uma calibração feita fria envelhece em minutos.",
    "<strong>Calibre (tela Calibração SOLT).</strong> Aberto, curto, carga e, "
    + "se você mede transmissão, thru. Sem calibração o f_res tem viés maior "
    + "que o sinal que você quer medir. Confira o número de condicionamento: "
    + "condicionamento ruim é quase sempre padrão trocado ou mal rosqueado.",
    "<strong>Ache a banda (tela Varredura).</strong> Varra largo, localize a "
    + "ressonância e aperte a banda do ajuste em volta dela. Confira o modelo "
    + "ajustado desenhado por cima dos dados: se ele não segue o pico, nenhum "
    + "número adiante presta.",
    "<strong>Meça o ruído (tela Osciloscópio).</strong> Com o sensor parado e "
    + "a amostra em repouso, deixe correr um minuto e anote o σ de 60 s. Esse "
    + "é o σ medido da sua bancada — é ele que vira o limite de detecção, no "
    + "lugar de um valor suposto.",
    "<strong>Defina a curva (esta tela).</strong> Escolha a grandeza Y, digite "
    + "o nome e a unidade da grandeza X, e digite a covariável que você vai "
    + "registrar. Clique em Nova curva.",
    "<strong>Planeje a série.</strong> Use o botão Planejar série: escolha o "
    + "mínimo, o máximo, o passo, quantas réplicas e um nível de referência "
    + "para intercalar. Prepare no mínimo cinco níveis de X e duas réplicas — "
    + "com menos que isso não há como separar deriva de resposta.",
    "<strong>Prepare as amostras antes de começar a medir</strong>, todas, e "
    + "deixe-as chegar ao equilíbrio com o ambiente. Meça na ordem que a lista "
    + "mandar, mesmo quando parecer absurda: a ordem sorteada é o instrumento "
    + "de controle, não um capricho.",
    "<strong>Em cada ponto:</strong> ponha a amostra, espere estabilizar, "
    + "digite X e a covariável, confira o número de medidas e capture. Entre "
    + "amostras, limpe e seque a célula do mesmo jeito toda vez — a "
    + "repetibilidade do procedimento vira o σ da sua curva.",
    "<strong>Ajuste e olhe os resíduos.</strong> Comece pelo linear. Depois "
    + "veja o resíduo contra a ordem de execução e contra a covariável. "
    + "Tendência contra a ordem é deriva; tendência contra a covariável pede o "
    + "ajuste com covariável.",
    "<strong>Feche o colchete.</strong> No fim da sessão, volte à tela de "
    + "calibração e reverifique os padrões. A reverificação diz quanto o "
    + "instrumento andou durante o experimento — sem ela, você não sabe se a "
    + "curva mediu a amostra ou o aparelho.",
    "<strong>Exporte antes de fechar.</strong> CSV da curva e, se for publicar, "
    + "o Touchstone das varreduras. No modo navegador isso é obrigatório: "
    + "limpar os dados do site apaga tudo.",
  ];

  /* -------------------------------------------------------------- montagem
     Os textos acima trazem marcação (`<strong>`, `<code>`) de propósito e vão
     para o HTML como estão. Eles são literais deste arquivo: nada aqui vem do
     usuário nem da rede, então não há o que escapar. */
  function lista(itens, ordenada) {
    const tag = ordenada ? "ol" : "ul";
    return "<" + tag + ">" + itens.map((i) => "<li>" + i + "</li>").join("")
      + "</" + tag + ">";
  }

  /** Escreve o manual inteiro dentro do elemento dado. */
  function monta(el) {
    if (!el) return;
    let h = "";

    h += "<h3>Instalar numa máquina nova</h3>";
    h += "<p>Há dois caminhos, e os dois funcionam no Linux e no Windows. O "
      + "primeiro não instala nada; o segundo grava em arquivo e é o da "
      + "bancada.</p>";
    INSTALACAO.forEach(function (bloco) {
      h += "<h4>" + bloco[0] + "</h4>" + lista(bloco[1], true);
    });

    h += "<h3>Preparar o experimento</h3>";
    h += "<p>Na ordem. Pular um passo não impede de medir; impede de saber o "
      + "que a medida vale.</p>";
    h += lista(PREPARO, true);

    h += "<h3>Termos e conceitos</h3>";
    h += "<p>Os mesmos textos aparecem como dica quando o ponteiro para em "
      + "cima de cada campo da tela.</p><dl>";
    Object.keys(TERMOS).forEach(function (k) {
      h += "<dt>" + TERMOS[k][0] + "</dt><dd>" + TERMOS[k][1] + "</dd>";
    });
    h += "</dl>";

    el.innerHTML = h;
  }

  /** Põe a dica em todo elemento com `data-termo` dentro da raiz dada. */
  function aplicaDicas(raiz) {
    const r = raiz || document;
    Array.prototype.forEach.call(r.querySelectorAll("[data-termo]"),
      function (el) {
        const t = TERMOS[el.getAttribute("data-termo")];
        if (t) el.title = t[0] + " — " + t[1];
      });
  }

  /** `data-termo` sem verbete. Só para conferência durante a manutenção. */
  function orfaos(raiz) {
    const r = raiz || document;
    return Array.prototype.map.call(r.querySelectorAll("[data-termo]"),
      (el) => el.getAttribute("data-termo")).filter((k) => !TERMOS[k]);
  }

  return { termos: TERMOS, monta: monta, aplicaDicas: aplicaDicas,
           orfaos: orfaos };
})();
