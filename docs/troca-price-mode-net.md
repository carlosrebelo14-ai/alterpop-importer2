# Troca para PRICE_MODE=NET: sequência da sessão

Regra NET (Decisão 31): preço sem IVA, arredondado para cima à dezena de cêntimos; o IVA fica todo na Shopify.
A loja tem `taxesIncluded = true` (preços com imposto incluído). Os dois lados têm de mudar na mesma janela:
se os preços NET ficassem com impostos incluídos, os clientes pagariam sem IVA; se os impostos passassem a "não
incluídos" com os preços antigos (já com IVA), o IVA seria cobrado duas vezes. Este documento não tem preços,
custos nem margens.

Quem faz o quê: os passos de leitura (`price_check`, `catalog_health`, `diagnose_theme`) correm no workflow
`maintenance`, que dispara a Claude e lê o resultado. Os passos de escrita (impostos na Shopify, `fly secrets`,
"Aplicar aos publicados") são do Carlos. Nada disto se faz com um sync, uma publicação ou uma indexação a decorrer.

## Antes da janela (qualquer dia)

| # | Passo | O que se verifica |
|---|---|---|
| P1 | `price_check` | regra do servidor **LEGACY**, impostos incluídos **true** ("estado coerente de antes"); `falhados = 0`, `nao_encontrados = 0`, `sem_registo = 0` (se não for zero, perceber cada um antes de avançar); `a_atualizar` + `fora_preco_manual` + `trancados` + `conformes_net` = `publicados` |
| P2 | `catalog_health` | 16 verdes, 0 vermelhas |
| P3 | `diagnose_theme` | `read_themes` concedido; contrato do tema sem bloqueios |
| P4 | No painel, "Pré-visualizar regra NET" | os totais batem com o `price_check` (a atualizar, fora por preço manual); as 5 linhas de amostra descem cerca de um sexto (1/1,21) em degraus de 10 cêntimos; a tabela "Fora por preço manual" lista os produtos que ficam como estão |
| P5 | Fila | sem aprovados à espera de publicar (senão o próximo ciclo publicaria já com a regra NET e impostos incluídos) |
| P6 | Fly | `fly volumes snapshots create` do volume `/app/data` (cópia do SQLite com `PriceHistory` e `lastPriceWrite`) |
| P7 | Shopify, Definições → Impostos e direitos | anotar (captura de ecrã) a configuração atual por região; confirmar que o IVA está configurado para cobrar nos países onde vendes |

A troca faz-se numa hora sem tráfego. Opcional: palavra-passe da loja ligada durante a janela, para ninguém comprar a meio.

## A janela (cerca de 15 minutos)

| # | Passo (quem) | Verificação logo a seguir |
|---|---|---|
| W1 | Shopify: Definições → Impostos e direitos → em cada região, tirar "incluir imposto nos preços" (preços sem imposto). Guardar. (Carlos) | `price_check`: impostos incluídos **false**, regra **LEGACY**. Aviso "estado intermédio" esperado: durante estes minutos os preços antigos levam IVA por cima |
| W2 | `fly secrets set PRICE_MODE=NET -a alterpop-importer-app` (reinicia a app) (Carlos) | quando a app responder: `price_check` mostra regra **NET**, impostos **false** ("estado coerente de depois"); `a_atualizar` igual ao de P1. No painel o botão "Pré-visualizar regra NET" desaparece e "Aplicar aos publicados (N)" aparece com o mesmo N |
| W3 | Painel: "Aplicar aos publicados", âmbito "todos os publicados com regra desatualizada", **sem** "Incluir preços manuais". Conferir totais e amostra, escrever a confirmação, atualizar. (Carlos) | resultado: N atualizados, 0 falhados. `price_check`: `a_atualizar = 0` e `conformes_net` = publicados menos os fora por preço manual/trancados |
| W4 | Loja: abrir 2 produtos, pôr no carrinho, checkout com morada em Portugal (sem pagar). (Carlos) | o IVA aparece como linha à parte; total = preço × (1 + taxa de IVA do país). Repetir com morada noutro país da UE onde vendes |
| W5 | Preços manuais: abrir a tabela "Fora por preço manual" da pré-visualização. Cada um foi fixado com IVA incluído e agora leva IVA por cima. Decidir um a um: editar o preço manual na curadoria para o valor NET, ou repetir "Aplicar aos publicados" com "Incluir preços manuais". (Carlos) | `price_check`: `fora_preco_manual` volta a 0, ou fica só o que se decidiu manter |
| W6 | `catalog_health` e `diagnose_theme` | 16 verdes; tema sem bloqueios |

Se a janela tiver de parar entre W1 e W3, a loja fica com preços 21 % acima do pretendido (sobreavaliados), nunca com IVA em falta: é a ordem que falha para o lado seguro.

## Como desfazer

Regra: nunca deixar preços NET com impostos incluídos (cobraria sem IVA). Desfazer repõe primeiro os preços, depois os impostos.

| Estado em que se está | Desfazer |
|---|---|
| Só W1 feito | Shopify: voltar a incluir imposto nos preços. `price_check`: impostos **true**, regra **LEGACY** |
| W1 e W2 feitos, W3 por fazer | `fly secrets unset PRICE_MODE -a alterpop-importer-app` (volta à regra antiga); Shopify: voltar a incluir imposto nos preços. `price_check` igual ao de P1 |
| W3 feito (total ou parcial) | 1) `fly secrets unset PRICE_MODE` (regra LEGACY). 2) Painel: "Aplicar aos publicados": como os preços foram escritos com a regra NET, a regra antiga aparece como desatualizada e repõe os preços com IVA (mesmos passos do W3). 3) Só depois, Shopify: voltar a incluir imposto nos preços. 4) Preços manuais alterados no W5: repor à mão; o valor anterior está no histórico de preços (`PriceHistory`), com regra e origem. Verificação: o painel mostra "Todos os publicados estão conformes com a regra"; `price_check` com regra LEGACY e impostos **true** (o `price_check` compara sempre com a regra NET: depois do desfazer, `conformes_net` é baixo, o que é esperado) |
| Algo corrompido na base de dados | Restaurar o snapshot do volume tirado em P6 (`fly volumes create ... --snapshot-id`), com a app parada. Os preços na Shopify repõem-se pelo passo 2 acima |

Nada disto liga `THEME_GUARD` nem mexe no tema.
