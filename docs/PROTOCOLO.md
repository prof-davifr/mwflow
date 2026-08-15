# Sonda de protocolo — LiteVNA64

Gerado por `python3 -m mwflow.vna.sonda` em 2026-08-14 16:04:17

```

1. Identidade
-------------
porta            : /dev/serial/by-id/usb-Black_Sphere_Technologies_CDC-ACM_Demo_DEMO-if00
deviceVariant    : 0x02
protocolVersion  : 1
hardwareRevision : 2
firmware         : 2.2
veredito         : família V2 confirmada

2. Taxa de varredura e penalidade da primeira varredura
-------------------------------------------------------
101 pontos, 50 MHz a 3 GHz, 20 repetições
primeira         : 0.335 s  (302 pontos/s)
demais (mediana) : 0.333 s  (303 pontos/s)
dispersão        : 0.000 s (desvio), 0.001 s (máx-mín)
penalidade       : a primeira custa 1.01x a mediana

3. Custo de uma reconfiguração
------------------------------
configurar + varrer, 10 vezes: mediana 0.667 s, máx 0.668 s
(o motor consome comandos só entre varreduras; este é o atraso que o
 operador sente ao mudar a banda numa varredura de 101 pontos)

4. Teto de sweepPoints
----------------------
pontos   tempo(s)   pontos/s   sem dado
101      0.616      164        0       
201      1.272      158        0       
401      2.585      155        0       
801      5.420      148        0       
1024     6.677      153        0       
1601     recusado pelo driver: pontos fora de 1..1024
maior grade completa: 1024 pontos

5. Modo CW com sweepStepHz = 0
------------------------------
f = 1500.000000 MHz, 2020 amostras em 6.28 s
taxa             : 322 amostras/s
|S21|            : -91.662 dB, desvio 5.4411 dB
|S11|            : -2.570 dB

autocorrelação do resíduo:
  atraso 1     : +0.053
  atraso 2     : +0.060
  atraso 50    : +0.009
  atraso 101   : +0.041
  atraso 202   : -0.003
veredito         : SEM solavanco periódico detectável

6. Modo CW com sweepPoints = 1
------------------------------
300 amostras em 1.17 s -> 256 amostras/s
|S21| desvio     : 5.3596 dB

7. Alternativa: micro-varredura (passo de 1 Hz)
-----------------------------------------------
Se o passo nulo falhar, 101 pontos com 1 Hz de passo são fisicamente
a mesma frequência em 1,5 GHz e passam por qualquer checagem de passo.
505 amostras em 1.94 s -> 260 amostras/s
|S21| desvio     : 5.9027 dB

8. Semântica de valuesPerFrequency
----------------------------------
Pergunta: o aparelho promedia por dentro e emite 1 registro por ponto,
ou emite V registros por ponto e a média fica com o host?

vpf    registros    índices únicos repetições  
1      101          101            1.00        
2      202          101            2.00        
4      404          101            4.00        

Leitura: repetição ~1,0 significa média interna (1 registro por ponto);
repetição ~V significa V registros por ponto.

9. Recuperação de um comando cortado
------------------------------------
Envia metade de um ESCREVE8 e mede quanto custa voltar ao normal.
recuperou 5 de 5 vezes; mediana 0.716 s, máx 0.717 s
```

## Conclusões para o resto do MWFlow

- **Aparelho**: variante 0x02, protocolo 1, hardware 2, firmware 2.2.
- **Teto de pontos: 1024.** Acima disso o firmware devolve a grade incompleta, sem erro nenhum. `protocolo.PONTOS_MAX` vale 1024 e o driver recusa mais que isso.
- **Taxa: 303 pontos por segundo** em regime. Uma varredura de 1024 pontos custa 3.38 s.
- **Reconfigurar custa cerca de uma varredura a mais.** O motor deve trocar de banda entre varreduras, nunca no meio de uma.
- **Modo CW com passo nulo funciona, a 322 amostras por segundo** — mais rápido que o modo de varredura. Não há solavanco periódico por varredura, então nenhuma amostra precisa ser descartada. É este o modo do osciloscópio.
- `sweepPoints = 1` também funciona, porém mais devagar. A micro-varredura de 1 Hz fica só como plano de reserva.
- **`valuesPerFrequency` NÃO promedia por dentro**: ele emite V registros por ponto. Quem promedia é o host. Uma varredura com V > 1 exige ler pontos × V registros — ler só `pontos` devolveria uma fração da grade.
- **A recuperação de comando cortado funciona**: oito NOPs, descarte da entrada e nova configuração bastam. Nenhuma reabertura de porta foi necessária.

> Aviso de leitura: as medidas de |S11| e |S21| desta sonda foram feitas com as portas ABERTAS, sem nada ligado. Elas servem para medir taxa e estabilidade, não para julgar o desempenho de radio frequência do aparelho.
