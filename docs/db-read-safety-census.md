# Censo — segurança das leituras Prisma (Tarefa 59, Decisão 30)

Todos os call sites de `prisma.<model>.findMany(`, `.findUnique(`, `.findFirst(` e `.count(` em `lib/` e `scripts/`, passem ou não por `safePrisma`. `docs/safe-prisma-fallback-census.md` (Tarefa 51) já cobria escrita/eliminação via `safePrisma` sem `fallback`; este censo é sobre LEITURAS especificamente, incluindo as que nem usam `safePrisma`.

Critério: **um erro de query lançado é distinguível de um resultado genuinamente vazio, pelo código que consome o valor?**

- **BLOCKING** — erro engolido (safePrisma sem fallback/rethrow) OU chamada crua sem try/catch que nada a montante apanha de forma a impedir o resultado (já "falhado") de ser lido como "vazio" — E o resultado responde a uma pergunta de negócio ("isto existe", "quantos há", "é um alvo válido") cuja resposta errada parece saída normal e confiável. É exatamente a forma dos dois incidentes reais desta sessão.
- **SAFE** — ou (a) a falha não é engolida e produz um crash alto e visível, sem fallback silencioso que pareça dado válido; ou (b) já tem tratamento equivalente ao padrão novo (rethrow + verificação de consistência); ou (c) o resultado não responde a uma classificação de negócio (diagnóstico puro, logging, contadores de UI não-críticos autocorretivos).
- **UNCLEAR** — ambíguo, precisa de leitura humana adicional.

## BLOCKING

| File:Line | Call | Usado para | Porquê |
|---|---|---|---|
| `lib/importer/catalog/catalogProductsDb.server.js:847` (`getCatalogProductTotal`) | `catalogProduct.count`, fallback `0` | Portão "catálogo já está vazio?" antes de purge/purgeElite/reindex | Falha→0, indistinguível de catálogo genuinamente vazio; purges saltam trabalho real em silêncio. |
| `lib/importer/sync/syncStagingSummary.server.js:25` | `catalogProduct.findMany`, fallback `[]` | API de pré-visualização de sync: "encontrados vs em falta" antes de publicar | Falha→`[]` reporta TODOS os SKUs aprovados como em falta — literalmente o sintoma do Incidente 1, mostrado ao admin antes de publicar. |
| `lib/importer/shopify/publishedStockSync.server.js:49` | `catalogProduct.findMany`, fallback `[]` | Lookup de stock local para SKUs PUBLISHED antes de empurrar inventário para a Shopify | Falha→`[]` faz todo o SKU publicado parecer "não indexado", sync de stock salta todos em silêncio. |
| `lib/importer/catalog/skuLifecycle.server.js:64` | `catalogProduct.findMany` (currentRows), fallback `[]` | Diff novo/presente/em falta por ciclo | Falha→`[]` classifica mal TODO SKU real como "em falta este ciclo", corrompe a tabela de tracking e os sinalizadores de descontinuação. |
| `lib/importer/catalog/skuLifecycle.server.js:73` | `catalogSkuTracking.findMany` (trackingRows), fallback `[]` | Baseline para diff de SKU novo/em falta | Falha→`[]` classifica mal todo SKU atual como "novo", inunda alertas falsos de SKU novo/VIP. |
| `lib/importer/catalog/skuLifecycle.server.js:234` (`listSkusForReview`) | `catalogSkuTracking.findMany`, fallback `[]` | Página de relatório: SKUs marcados "precisa revisão" | Falha→`[]` parece igual a "nada precisa de revisão agora". |
| `lib/importer/jobs/backgroundWorker.server.js:37` (`recoverOrphanedJobs`) | `backgroundImportJob.findMany`, fallback `[]` | Recuperação única no arranque de jobs presos em "running" após restart | Falha→`[]` anula o próprio bug que esta função existe para corrigir; jobs ficam presos até ao próximo restart. |
| `lib/importer/jobs/backgroundQueue.server.js:111` (`getBackgroundImportStatus`) | `backgroundImportJob.findUnique`, fallback `null` | Polling do loop `waitForCompletion` do `jobRunner` | Falha→`null` → loop trata o job como desaparecido, devolve cedo como se tivesse desaparecido/terminado. |
| `lib/importer/curation/dynamicRules.server.js:119` (`primeMarketSettingsForShop`) | `marketSettings.findUnique`, fallback `null` | Config de marcas VIP/licenças usada pela curadoria, flag VIP do sku-lifecycle, UI de Settings | Falha→`null`→defaults, indistinguível de "ainda sem settings gravadas"; filtros VIP repõem-se a meio de ciclo. |
| `lib/importer/curation/marginErosion.server.js:44` | `catalogProduct.findMany`, fallback `[]` por chunk de SKUs | Lookup de custo atual para alertas de erosão de margem | Chunk falhado descarta SKUs do mapa de custo em silêncio — erosão real de margem parece "sem erosão", alerta não dispara. |
| `lib/importer/catalog/catalogProductsDb.server.js:468` | `catalogProduct.count`, fallback `0` (`Promise.all` com `findMany` na :461) | `totalCount`/paginação junto às linhas devolvidas na UI de curadoria | Falha→0 enquanto o `findMany` emparelhado pode ter sucesso com linhas reais — UI mostra produtos reais mas "0 total", contagem inconsistente em que o admin confiaria. |

## UNCLEAR

| File:Line | Call | Usado para | Ambiguidade |
|---|---|---|---|
| `lib/importer/shopify/franchiseCatalogSync.server.js:49` | `catalogProduct.findMany`, fallback `[]` | Flags de stock por franquia escritas no metafield da loja | Desenhado como best-effort/autocorretivo (sobrescrito no ciclo seguinte, o tema tem o seu próprio fallback para metafield obsoleto) — mas uma falha ainda escreve "sem stock" falso para TODAS as franquias na loja ao vivo até ao ciclo seguinte; gravidade depende da frequência do ciclo. |

## SAFE (resumo — ver detalhe completo no relatório da Tarefa 59)

54 call sites, incluindo os dois já corrigidos nesta sessão (`shopifyApprovedSync.server.js:66` com `rethrow:true`, `scripts/catalog/franchise-reconcile.js` com rethrow + verificação `count()` — confirma que o censo leu o código já corrigido, não uma versão antiga). O resto reparte-se por: scripts de diagnóstico sem try/catch mas sem fallback nenhum (crash alto via `main().catch`, ~20 casos), leituras que já lançam `undefined.map()`/`undefined.length` de propósito, contadores de dashboard autocorretivos e polling frequente (retry no próximo tick), e páginas de histórico/log só de display sem decisão automática dependente.

## Resumo

66 call sites de leitura no total: **11 BLOCKING**, **1 UNCLEAR**, **54 SAFE**. O grupo BLOCKING repete a forma exata dos dois incidentes em sítios novos — o mais próximo é `syncStagingSummary.server.js` (endpoint de pré-visualização de sync que mostraria "todos os SKUs em falta" numa soluço transitório da BD, o mesmo sintoma visível ao operador que o Incidente 1) e as duas queries centrais do `skuLifecycle.server.js`, que corromperiam a tabela persistente de tracking de SKU num único ciclo mau.

**Sem alteração de código nesta tarefa** além dos dois já corrigidos nas Tarefas 51 e 58. Decisão sobre corrigir os 11 BLOCKING fica para revisão futura — os dois de maior prioridade aparente são `syncStagingSummary.server.js` (visível ao operador antes de publicar) e o par `skuLifecycle.server.js:64`/`:73` (corrompe estado persistente, não só uma resposta pontual).
