# Censo — `safePrisma` sem `fallback` explícito

Tarefa 51 (Decisão 28), 2026-09-13. `safePrisma` (`lib/prisma/prismaSafe.server.js`) tem `rethrow: false` por defeito mesmo sem passar `opts` — qualquer chamada sem `fallback` explícito engole o erro e devolve `undefined`. O incidente do lote piloto v4 (`shopifyApprovedSync.server.js`, corrigido nesta tarefa) é uma instância deste padrão: erro de leitura → `undefined` → indistinguível de "0 linhas genuínas".

Este documento censa todos os outros call sites do repo com o mesmo shape, com veredicto por caso. **Não decide corrigir todos** — só o call site que causou o incidente foi alterado (`shopifyApprovedSync.server.js`, `rethrow: true`). Os restantes ficam registados para decisão futura.

## RISKY — mesmo padrão do incidente: erro engolido finge sucesso ou "não existe"

| File:Line | O que faz | Porque é arriscado |
|---|---|---|
| `lib/importer/catalog/catalogInsertBatch.server.js:105` | `catalogProduct.upsertBatch` — escrita principal do catálogo | Chamador faz `indexed += batch.length` incondicionalmente a seguir — escrita falhada é reportada como indexada, produtos perdem-se sem sinal. |
| `lib/importer/catalog/catalogProductsDb.server.js:91` / `:137` | `catalog.clear` — apaga tudo antes de reindexar | Se o wipe falhar em silêncio, linhas obsoletas sobrevivem ao invariante "limpo e reconstruído a cada ciclo" que `skuLifecycle.server.js` assume. |
| `lib/importer/catalog/syncCatalogWithProgress.server.js:117` | `catalog.clear` — mesmo padrão, sync em streaming | Igual ao anterior. |
| `lib/importer/curation/eliteCuration.server.js:134` | `catalog.elitePurge.delete` | `removed += slice.length` acontece independentemente de sucesso — é o MESMO bug já corrigido com `{ rethrow: true }` no `purgeDatabase.server.js:102` irmão, nunca aplicado aqui. |
| `lib/importer/curation/dynamicRules.server.js:130` | `marketSettings.upsert` — grava marcas VIP/licenças da UI de Settings | Em falha, `row` fica `undefined`; `fromDbRow(undefined)` devolve settings vazias, gravadas na cache e devolvidas à UI como se tivesse gravado — apaga configuração VIP em silêncio. |
| `lib/importer/jobs/backgroundQueue.server.js:57` | `backgroundImportJob.create` — enfileira job de import | `enqueueBackgroundImport` devolve o `id` e escreve estado "queued" independentemente da linha ter sido criada; o worker nunca vê o job, nunca corre. |
| `lib/importer/sync/syncErrorLog.server.js:60` | `syncErrorLog.create` — regista falha de sync por SKU | Se registar uma falha real falhar, a lista de erros no dashboard sub-reporta silenciosamente — o mesmo padrão "problema de infraestrutura parece ausência de problema". |
| `lib/importer/catalog/skuLifecycle.server.js:130` | `skuLifecycle.touchMissing` — UPDATE em massa a incrementar `missingCycles` | Falha silenciosa impede SKUs genuinamente descontinuados de acumular ciclos e chegar ao limiar de revisão — descontinuações reais ficam escondidas. |
| `lib/importer/catalog/skuLifecycle.server.js:113` | `skuLifecycle.touchPresent` — UPDATE em massa a repor `missingCycles`/status | Falha aqui para um SKU que voltou a stock deixa-o preso em `status: "review"` indefinidamente. |

## UNCLEAR — precisa de decisão humana

| File:Line | O que faz | Ambiguidade |
|---|---|---|
| `lib/importer/catalog/deduplicateCatalog.server.js:111` | `dedup.catalogProduct.findMany` | Em falha devolve `undefined`, `products.length` lança logo (crash visível) — mas falta confirmar que nada a montante engole essa exceção. |
| `lib/importer/catalog/skuLifecycle.server.js:94` | `skuLifecycle.insertNew` — createMany de SKUs novos | Falha silenciosa só faz redetetar os mesmos SKUs como "novos" no ciclo seguinte (autocorretivo) — mas pode espalhar alertas repetidos de "novo SKU VIP". |
| `lib/importer/catalog/catalogProductsDb.server.js:39` / `:80` | `catalogProduct.createMany` / `catalogProductFilterTag.createMany` — caminho de sync não-streaming | Mesmo risco do `upsertBatch`, mas a função está marcada `@deprecated` — gravidade depende de ainda ser invocada em produção. |

## SAFE — falha visível ou sem consequência de integridade

| File:Line | O que faz | Porque é seguro |
|---|---|---|
| `lib/importer/catalog/skuLifecycle.server.js:154` | `skuLifecycle.saveReport` | Registo histórico best-effort, função inteira em try/catch, "nunca lança" por desenho. |
| `lib/importer/catalog/skuLifecycle.server.js:205` | `skuLifecycle.prune` | Limpeza pura; falhar só adia uma retenção, repete no próximo ciclo. |
| `lib/importer/shopify/syncJobHistory.server.js:14` | `syncJob.create` | Valor de retorno nunca usado; falta de linha de auditoria não afeta decisão de negócio. |
| `lib/importer/sync/syncErrorLog.server.js:138` / `:155` / `:176` | update/deactivate/prune de erros | Pior caso é erro já real ficar visível mais tempo — direção oposta ao "esconder falha". |
| `lib/importer/jobs/backgroundQueue.server.js:160` | `backgroundImportJob.update` — progresso durante corrida | Display fica momentaneamente desatualizado, autocorrige-se na próxima chamada (repetida durante o job). |
| `lib/importer/catalog/catalogProductsDb.server.js:409/420/537/545/621/629/701/709` | `catalog.query.count` / `catalog.query.page` — paginação SQL crua da UI de curadoria | `countRows[0]` / `dataRows.map(...)` sobre `undefined` lança TypeError logo — crash visível, não "0 produtos" silencioso. |
| `lib/importer/catalog/catalogProductsDb.server.js:460` | `catalogProduct.findMany` (modo Prisma) | `rows.map(rowToLite)` sobre `undefined` lança logo. |
| `lib/importer/catalog/catalogProductsDb.server.js:810` / `:822` | `catalog.filterTag.groupBy` / `byBrand` — contagens de filtro do sitemap | `for...of` sobre `undefined` lança logo. |
| `lib/importer/catalog/purgeDatabase.server.js:71` / `eliteCuration.server.js:106` | `findMany` de lote para purga | Já têm `fallback: []` explícito — lote vazio só termina o loop mais cedo, nada é apagado por engano. |

## Resumo

De ~20 call sites sem `fallback` explícito: **9 RISKY**, **3 UNCLEAR**, **~10 SAFE**. O padrão de risco dominante não são leituras (a maioria já falha alto via `undefined.map()`/`undefined[0]`, ou já passa `fallback` explícito) — é **escrita/eliminação** (`upsertBatch`, `catalog.clear`, `elitePurge.delete`, `marketSettings.upsert`, `backgroundImportJob.create`, `syncErrorLog.create`), onde uma exceção engolida deixa um contador (`indexed +=`, `removed +=`) ou uma escrita de cache/estado avançar como se tivesse tido sucesso.

**Sem ação de código nesta tarefa** além do `shopifyApprovedSync.server.js` que causou o incidente. Decisão sobre corrigir os 9 RISKY fica para revisão futura — o mais próximo em urgência é `eliteCuration.server.js:134`, que já tem o padrão de correção pronto e testado no `purgeDatabase.server.js:102` irmão.
