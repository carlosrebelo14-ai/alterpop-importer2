# Registo de decisões — normalização de franquias

Uma entrada por decisão fechada pelo Carlos. Emendas ficam no bloco da decisão original, nunca reescrevem o texto fechado — o histórico conta.

---

## Decisão 17 — limiar de 3% na regra prefixo-formato

**Data:** 2026-09-11
**Estado:** fechada, **emendada pela Decisão 21** (ver abaixo)

`FORMAT_PREFIXES` reduzido a `Assorted` e `Latino` (Tarefa 32) — o censo da Tarefa 31 mostrou que "POP figure" sozinho era 79% das remoções, informação de formato genuína, não ruído a limpar do título. Reteste dos 5 casos obrigatórios + nova taxa global sobre o catálogo completo antes de qualquer `--execute`.

> ⚠️ **Ver Decisão 21** — a leitura original do "3%" como teto rígido foi corrigida. Não citar este limiar sem o ponteiro abaixo.

### Emenda — Decisão 21 (2026-09-12)

**Contexto do averbamento:** a Decisão 17 fixou um limiar de 3% sobre a taxa de alteração de títulos pela regra prefixo-formato. O limiar foi lido como teto rígido. A intenção real era portão de auto-aprovação. A corrida da Tarefa 33 mediu 3,4% exatos sobre o catálogo completo e foi aprovada nominalmente, o que expôs a ambiguidade.

**Texto normativo:**

> **Decisão 21 — Emenda à Decisão 17**
>
> O valor de 3% da Decisão 17 é portão de auto-aprovação, não teto rígido.
>
> Taxa ≤3% — o `--execute` do backfill de títulos corre sem aprovação adicional.
>
> Taxa >3% — o `--execute` exige aprovação nominal do Carlos por corrida, com o censo de prefixos removidos anexado ao pedido.
>
> A taxa medida na Tarefa 33 foi de 3,4% (854 de 25 420, contagem exata sobre o catálogo completo, sem amostragem). Excedeu o portão, teve aprovação nominal e foi executada. O backfill não é revertido.
>
> Esta regra aplica-se a qualquer `--execute` futuro do `title-clean` e a qualquer script de backfill em massa que altere campos de catálogo já resolvidos.

**Estado:** fechada
**Referência cruzada:** Decisão 17, Tarefa 32, Tarefa 33
**Sem alteração de código. Sem migração.**

---

## Decisão 24 — crossover multi-valor inalcançável com `resolvedFranchise` escalar

**Data:** 2026-09-12
**Estado:** fechada, sem ação nesta entrega

**Achado:** `resolvedFranchise` é um campo escalar (`String?`) no modelo `CatalogProduct` da Prisma. `alterpop.franchise` é uma lista (`list.single_line_text_field`) no Shopify — a plataforma suporta um produto pertencer a 2+ universos em simultâneo (crossover manual, validado em R1). Mas com a coluna Prisma escalar, nenhum produto pode alguma vez ter 2+ valores resolvidos: o crossover que R1 validou como suportado pela plataforma é **inalcançável pelo modelo de dados atual**.

**Como surgiu:** slot S4 do seletor do lote piloto (Tarefa 41/42, `pilot-batch-select.js`) pedia um SKU com `resolvedFranchise` de 2+ valores para validar crossover por lista. O predicado nunca teve candidatos — não por falta de dados no catálogo, mas porque a coluna não consegue representar essa forma. Ficou documentado no próprio script (comentário no predicado S4) para não voltar a ser testado às cegas.

**Decisão:** sem ação nesta entrega pré-inauguração. Tornar `resolvedFranchise` array exige migração Prisma (mudança de tipo de coluna, não `ADD COLUMN` trivial) e reescrita do `franchiseResolver.server.js` (camadas 1/2 e a escrita em `catalogInsertBatch.server.js`) para produzir e persistir múltiplos valores. Fora do âmbito do portão pré-inauguração — fica registado para uma entrega futura, se o negócio decidir que crossover multi-universo é necessário na prática (hoje é só capacidade teórica da plataforma, sem produto real que precise).

**Referência cruzada:** Tarefa 41, Tarefa 42, `pilot-batch-select.js` (slot S4)
**Sem alteração de código. Sem migração.**

---

## Decisão 25 — classe de risco nova: ref legítimo, licença inexistente

**Data:** 2026-09-12
**Estado:** fechada, sem ação ao resolver antes da inauguração

**Achado:** o feed OcioStock marca produtos com `ref=` de um universo licenciado sem que exista licença real — `franchiseRefs` contém literalmente `"HARRY POTTER"` num produto MGA Entertainment/Miniverse (`0035051531166`, "Miniverse Potion classroom Make It Mini Holiday Harry Potter set"). O atributo descreve tema, não licenciamento. O resolver está correto ao confiar no ref — a falha é a montante, no fornecedor.

A Tarefa 11 (`franchise-title-ref-contradiction.js`) não cobre esta classe: o critério ali é DISCORDÂNCIA entre título e ref, e neste caso título e ref concordam (ambos dizem "Harry Potter") — a concordância é exatamente o que torna o caso invisível a essa auditoria. Foi por isso que o diagnóstico inicial ("camada 2") estava errado — é camada 1 (`resolvedFranchiseLayer: 1`), ref e título ambos corretos tecnicamente, ambos errados comercialmente.

**Decisão:** sem alteração ao `franchiseResolver.server.js` antes da inauguração. Mitigação por curadoria manual do Carlos na seleção final. Censo de refs de licença duvidosa entra na Tarefa 47 (`franchise-brand-overlap-audit.js`, só relatório) — decisão sobre deny-list de marcas genéricas (mga, miniverse, bandai, jada, zuru, clearance) fica para revisão pós-inauguração.

**Referência cruzada:** Tarefa 11, Tarefa 45, Tarefa 47, `franchise-brand-overlap-audit.js`
**Sem alteração de código ao resolver. Sem migração.**

---

## Decisão 27 — a fila é fonte instável para seleção determinística

**Data:** 2026-09-13
**Estado:** fechada

**Achado:** `pilot-batch-select.js --approve` recalculava a seleção do zero em cada invocação. Entre a corrida que o Carlos revê e a corrida que aprova, a fila de curadoria pode mudar — revert de órfãos pós-wipe, reindexação do feed, produtos novos — e o conjunto elegível muda com ela. Na v4 do lote piloto, reverter 23 órfãos a PENDING (Tarefa 40) trouxe de volta `4573102620934`, que ficou à frente na ordenação sku ASC e substituiu silenciosamente `5010993884155` — um SKU já revisto e aprovado pelo Carlos — sem que a mudança fosse assinalada. A revisão manual só é real quando fixa SKUs; um predicado re-executável sobre uma fonte instável reabre a seleção a cada corrida.

**Decisão:** toda a seleção aprovada manualmente tem de ser fixada por lista de SKUs, nunca por predicado re-executável, entre a revisão e a escrita. `pilot-batch-select.js --approve` (sem `--pin`) passa a proibido — sai com erro sem escrever nada (Tarefa 50). O único caminho para aprovar é `--pin <sku,sku,...>`, que aprova exatamente essa lista e falha sem escrever se algum SKU não estiver `PENDING` ou se a contagem final não bater com o pedido.

**Aplica-se** à seleção final pré-inaugural também, não só ao lote piloto — qualquer ferramenta futura que aprove produtos a partir de uma consulta à fila deve seguir o mesmo padrão: listar, rever, fixar por SKU, só depois escrever.

**Referência cruzada:** Tarefa 40, Tarefa 50, `pilot-batch-select.js`
**Sem migração.**

---

## Decisão 28 — nenhuma sessão de leitura corre em paralelo com a publicação

**Data:** 2026-09-13
**Estado:** fechada

**Incidente:** publicar o lote piloto v4 falhou 6 de 8 produtos com "SKU não encontrado no catálogo indexado (SQLite)". Diagnóstico: 2 sucessos seguidos de 6 falhas descarta ausência real de dados (uma query falhada teria derrubado os 8, não uma fração) — foi contenção SQLite entre `runApprovedShopifySync` e as várias sessões `fly ssh console` com Prisma que corriam em paralelo para verificação manual. O ficheiro SQLite vive num volume único (escritor único); cada sessão abre a sua própria ligação Prisma, e uma leitura/escrita concorrente pode segurar o lock além do `busy_timeout`.

**Causa agravante (corrigida na Tarefa 51):** `safePrisma` sem `fallback` explícito convertia o erro de query em ausência de linhas — o sync não distinguia "SKU não existe" de "não consegui ler", e reportava sempre o primeiro.

**Decisão:**
> Nenhuma sessão `fly ssh console` com Prisma corre em paralelo com `runApprovedShopifySync` (ou qualquer escrita em massa no catálogo). O SQLite no volume é de escritor único. Verificações fazem-se ANTES ou DEPOIS de uma corrida de publicação, nunca DURANTE.

**Aplica-se** a toda a importação pré-inaugural, não só ao piloto — inclui backfills, reconciliação, e qualquer diagnóstico ad-hoc.

**Referência cruzada:** Tarefa 51, `shopifyApprovedSync.server.js`, `lib/prisma/prismaSafe.server.js`
**Sem migração.**

---

## Decisão 29 — `SYNC_ERROR` é estado terminal, protegido do reindex

**Data:** 2026-09-13
**Estado:** fechada

**Achado:** o retry do lote piloto v4 (Tarefa 52) revelou que `upsertCurationQueueFromRecordLocked` (`lib/curation/curationQueue.server.js`) não incluía `SYNC_ERROR` na lista `isManual` — um reindex do feed (relógio de 45 min) recalcula o item pelas regras automáticas e pode devolvê-lo sozinho a `APPROVED`, sem revisão humana. Confirmado ao vivo: 5 dos 6 SKUs em `SYNC_ERROR` da paragem anterior viraram `APPROVED` sozinhos entre a paragem e o retry, não por ação minha nem do Carlos.

**Risco à escala:** um erro de publicação é informação que exige juízo humano — pode ser transitório (como foi aqui) ou sintoma de um problema real no produto. Se o reindex o limpa sozinho, o produto republica na corrida seguinte como se nada tivesse falhado, e "0 falhas" deixa de significar "0 problemas".

**Decisão:**
> `SYNC_ERROR` entra na lista de estados protegidos de `upsertCurationQueueFromRecordLocked`, ao lado de `APPROVED`, `REJECTED` e `PUBLISHED` — mas de forma INCONDICIONAL, sem a exceção de `smartRule`/`aiCuration`/`eliteCuration` que os outros três têm (uma falha de sync exige revisão humana seja qual for a origem da aprovação anterior). Só transição manual (`setManualOverride`, `approveProduct`, `bulkSetQueueStatus`) tira um SKU de `SYNC_ERROR` — o reindex do feed nunca o sobrepõe.

**Referência cruzada:** Tarefa 52, Tarefa 53, `lib/curation/curationQueue.server.js`
**Sem migração.**

---

## Decisão 30 — falha de leitura nunca se converte em conclusão de negócio

**Data:** 2026-09-13
**Estado:** fechada

**Achado:** a mesma classe de bug apareceu DUAS vezes em ficheiros diferentes na mesma sessão. Primeiro em `shopifyApprovedSync.server.js` (Tarefa 51/Decisão 28) — `safePrisma` sem `fallback` engoliu uma falha de leitura SQLite e converteu-a em "SKU não encontrado", falhando 6 produtos reais. Depois em `franchise-reconcile.js` (Tarefa 58) — uma query direta, sem `safePrisma` nem qualquer verificação, devolveu 8 linhas numa corrida e 2 linhas na seguinte para os MESMOS 8 SKUs, sem exceção lançada, e o script reportou `NO_CATALOG_ROW` a mais na primeira corrida como se fosse um facto sobre o catálogo.

**Padrão comum:** uma ferramenta de verificação que reporta ausência de dados quando a leitura falha é pior do que não ter ferramenta — dá luz verde falsa e luz vermelha falsa, e o operador aprende a re-correr até dar limpo. "Re-correr até dar limpo" é sintoma, não remédio.

**Decisão:**
> Falha de leitura nunca se converte em conclusão de negócio. Qualquer script que classifique estado de catálogo, fila ou loja tem de abortar com exit code não-zero perante erro de query. `NO_CATALOG_ROW`, `MISSING` e equivalentes reservam-se a ausência confirmada por leitura bem sucedida — nunca a uma leitura que falhou ou que não bate com uma segunda leitura de confirmação.

**Aplica-se** a toda a importação pré-inaugural — qualquer script futuro que classifique estado (existe/não existe, quantos há, está correto/errado) sobre catálogo, fila de curadoria, ou coleções da loja segue este padrão: query em try/catch, erro aborta sem classificar nada, e onde fizer sentido uma segunda leitura de confirmação antes de reportar "0"/"ausente".

**Referência cruzada:** Decisão 28, Tarefa 51, Tarefa 58, Tarefa 59, `docs/safe-prisma-fallback-census.md`
**Sem migração.**
