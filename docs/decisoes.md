# Registo de decisões — normalização de franquias

Uma entrada por decisão fechada pelo Carlos. Emendas ficam no bloco da decisão original, nunca reescrevem o texto fechado — o histórico conta.

---

## Decisão 13 — schema muda só por passo manual de deploy

**Data original:** 2026-09-11 (incidente da Tarefa 27, citado no comentário do `Dockerfile`). Registada em 2026-10-14, porque o Lote 0 depende dela.
**Estado:** fechada, em vigor.

Regra vivia só em comentários de `Dockerfile:25-29` e `prisma/schema.prisma:112-117`.

> 1. `prisma db push` não corre no arranque do contentor. Um `DROP COLUMN` com dados, recusado por falta de `--accept-data-loss`, reiniciou a máquina dez vezes seguidas e pôs a app em baixo cerca de 20 minutos.
> 2. A mudança de schema é um passo de deploy deliberado e manual: `fly ssh console -C "sh -lc 'cd /app && npm run db:push'"`, depois do `fly deploy`. Lê-se o aviso de perda de dados antes de decidir o `--accept-data-loss`.
> 3. Esta regra estende-se à runtime. Nenhum código da app corre `prisma db push` por conta própria (ver DBG-01, Decisão 34).

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

---

## Decisão 31 — preço sem IVA (`PRICE_MODE=NET`), histórico, mercado e ações em massa só sobre PENDING

**Data:** 2026-10-13
**Estado:** fechada (código entregue; ativação depende de passos do Carlos, ver abaixo)

**Achado:** a regra de preço de 07/10/2026 inclui o IVA espanhol no custo (`precio_distribuidores × 1,21`), arredonda a ,50/,90 e prende o preço entre 80 % do PVPR e o PVPR. O IVA de venda é da Shopify (impostos e OSS), não da app. A loja tem hoje `taxesIncluded = true`: um preço de 11,00 € enviado pela app aparece ao cliente como 11,00 € com IVA incluído.

**Risco à escala:** mudar a configuração de impostos da Shopify antes de reprecificar os publicados faz as páginas mostrarem IVA a dobrar; ligar a regra nova sem mudar os impostos publica preços sem IVA numa loja que os trata como preços com IVA. O histórico para o preço riscado Omnibus misturaria preços com e sem IVA, e a comparação com os preços da Worten/Fnac (com IVA) com o nosso (sem IVA) daria diferenças falsas.

**Decisão:**
> 1. **Regra NET** atrás da flag `PRICE_MODE=NET`, desligada por omissão. Custo = `round(precio_distribuidores × 100)` em cêntimos; preço = `ceil(custo × (1 + margem) / 10) × 10` (aritmética inteira); sem IVA, sem piso de 10 %, sem piso nem teto do PVPR; PVPR só informativo; estado único `MARGEM`. Com a flag desligada, publisher e "Aplicar aos publicados" usam a regra anterior, sem alteração.
> 2. **`evaluatePrice`** (`lib/importer/pricing/pricing.server.js`, antes `priceRow`) é a função única para painel, fila, staging, publisher, export, import de edições, reconciliação e "Aplicar aos publicados". Aceita `{ rule }` para calcular numa regra pedida sem mudar a global. `PRICE_MODE` com valor desconhecido lança.
> 3. **Troca numa só janela.** A pré-visualização de "Aplicar aos publicados" aceita `rule=NET` com a flag desligada (só leitura; `execute` recusa uma regra diferente da do servidor, 409 `RULE_MISMATCH`). Ordem: pré-visualizar com `rule=NET` → mudar os impostos na Shopify, ligar `PRICE_MODE=NET` e aplicar a todos os publicados na mesma sessão → antes do lançamento público.
> 4. **Preço manual** (`overrides.price`) é preservado, com autor, data e motivo (`overrides.priceMeta`), e fica fora de "Aplicar aos publicados" por omissão (`includeManual`).
> 5. **Histórico** (`PriceHistory`): cada preço enviado à Shopify fica com data e a regra com que foi calculado (`NET`/`LEGACY`). O mínimo Omnibus dos 30 dias (`omnibusMinCents`) só considera entradas da regra em vigor. É só calculado e exposto: a app não escreve `compareAtPrice`.
> 6. **Mercado** (`MarketPriceObservation`, `POST /api/market-prices/manual`): observação manual opcional (Worten, Fnac). O preço observado tem IVA e o nosso não, por isso a app não calcula diferença entre os dois: mostra o observado com a etiqueta «com IVA».
> 7. **Ações em massa** (aprovar/rejeitar, seleção e filtro) só tocam produtos `PENDING`. SKU sem entrada na fila conta como `PENDING`: a ação cria a entrada e aplica a transição, numa só operação idempotente, e reporta `createdCount` à parte. `PUBLISHED`, `REJECTED`, `SYNC_ERROR` e `APPROVED` ficam intocados. O número a confirmar é o dos elegíveis.
> 8. **Fila de decisão** (Prontos a aprovar, Preço manual, Regra desatualizada, Erros de sincronização) como filtro de estado (`group:<id>`). Avisos nunca bloqueiam a aprovação; stock não conta.

**Aplica-se** a todo o preço enviado à Shopify. Responsabilidade do Carlos: configurar impostos na Shopify, testar um produto em rascunho com morada PT e DE, fechar com o contabilista o enquadramento VIES e OSS, e ligar `PRICE_MODE=NET` depois do teste.

**Referência cruzada:** `lib/importer/pricing/priceMode.js`, `omnibus.js`, `priceHistory.server.js`, `marketPrice*.js`, `lib/curation/bulkEligibility.js`, `decisionQueue*.js`, `prisma/migrations/20261013120000_price_history_market`
**Migração:** tabelas novas e aditivas (`PriceHistory`, `MarketPriceObservation`); sem colunas novas em `CatalogProduct`. Aplicar com `npm run db:push` na Fly, depois de `fly deploy`.

---

## Decisão 32 — guarda do tema publicado, só de leitura (`read_themes`)

**Data:** 2026-10-13
**Estado:** fechada (ativação com `THEME_GUARD=ON` depois de reautorizar a app)

**Achado:** o tema Universe/Line depende de templates (`collection.universe-room.json`, `collection.line.json`), do template de produto e de definições `alterpop.*` com acesso storefront. Nada na app verificava que o tema publicado ainda os tem antes de um lote de publicação.

**Decisão:**
> 1. A app lê o tema `MAIN` (scope `read_themes`; nunca `write_themes`) e valida um contrato declarado no repositório (`lib/importer/shopify/themeContract.js`). **Nenhuma operação escreve em assets, templates ou settings do tema** (só queries; teste estrutural).
> 2. **Bloqueia** o lote: template de coleção Universe/Line ou de produto em falta; definição `alterpop.*` declarada `PUBLIC_READ` em falta ou sem esse acesso (as declaradas `NONE` — `franchise`, `line`, `manufacturer_line` — ficam de fora de propósito); handles e regras de Universe/Line divergentes (guarda existente `franchiseConditionsGuard`). **Avisa** no staging, sem bloquear: `settings_data.json`, secções referenciadas em falta, filtros.
> 3. Mudança de `updatedAt` do tema reconstrói o snapshot (`data/theme-contract/<loja>.json`) e reavalia; sozinha não bloqueia. Scope em falta é um estado próprio (`scope_missing`), não «tema inválido».
> 4. O portão corre uma vez por lote (`runApprovedShopifySync`, depois da guarda de franquias) e na rota `/api/shopify-sync` antes de iniciar o job, e só recusa por contrato inválido ou erro técnico de leitura. Fica desligado até `THEME_GUARD=ON`, para o deploy anterior à reautorização não bloquear as publicações.
> 5. `GET /api/theme-contract/status`, `POST /api/theme-contract/refresh`, `themeCompatibility` em `GET /api/products`. O script `theme-template-audit.js` passa a usar o serviço.

**Referência cruzada:** Decisão 31, `lib/importer/shopify/themeContract.server.js`, `scripts/tests/theme-contract.test.js`
**Sem migração.** Reautorizar a app antes de ativar a guarda.

---

## Decisão 33 — pacote de decisões do debug geral de 14/10/2026

**Data:** 2026-10-14
**Estado:** fechada pelo Carlos. Os pré-requisitos abaixo estão abertos e não bloqueiam o registo.
**Origem:** relatório `docs/relatorios/debug-geral-14-10-2026.md`. Verificação contra o repo feita por leitura, sem alterações ao código.

**Decisão:**
> 1. **DBG-16.** Produto publicado que sai do feed é despublicado e aparece no painel numa lista para o Carlos escolher substituto.
> 2. **Comandos em produção.** O developer corre `git push`, `bash scripts/deploy.sh`, leituras e dry-runs sozinho. O deploy passa sempre por `scripts/deploy.sh`, com as quatro guardas.
> 3. **`--execute` em produção** precisa do OK do arquiteto. O Carlos sai deste circuito.
> 4. **DBG-03** fica P1 e sobe a P0 nos SKUs que o Carlos apagou na loja. O critério P0 não muda.
> 5. **Lote 0** avança já com DBG-01 e DBG-02 em PRs separados.
> 6. **DBG-10.** "Blister" sozinho passa a prefixo de formato, sai do título e fica em `alterpop.format` com valor em inglês.

**Substitui:**
- Briefing 17/09, §1, "Comandos em produção" (`docs/briefings/arranque-character-17-09-2026.md:15`). Ponto 2.
- `docs/FLY-STAGING.md:7-9` ("Quem corre: o Carlos") e `:19` ("Nunca flyctl deploy à mão"). A mesma regra está em `README.md:65`. Ponto 2.
- Decisão 21 (`:26` e `:28`), aprovação nominal do Carlos para `--execute`. Ponto 3.
- OK do Carlos antes de `--execute` em `docs/FLY-STAGING.md:15` e `:71`, `docs/briefings/arranque-character-17-09-2026.md:157`, `docs/PROJECT-TODO.md:211` e `scripts/catalog/curation-mark-deleted.js:12`. Ponto 3.
- Não substitui: briefing 17/09 `:24` ("Nunca productUpdate"). Fica em vigor até DBG-16 ser implementada. Ver pré-requisitos.

**Pré-requisitos abertos (verificados em 14/10):**
- **Ponto 1.** A regra "A app nunca despublica" está escrita para coleções em `collectionPublicationReconcileCycle.server.js:12-13`, `collectionPublication.server.js:19` e `scripts/catalog/pre-pilot-verify.js:536`. A substituição vale só para produtos. Não existe mutação de despublicação no repo, e a fila não tem estado "despublicado". O gatilho (3 ciclos ausentes, `skuLifecycle.server.js:48`) não tem guarda contra ausência em massa, só contra SKUs novos (`:114-118`). Falta a lista de substitutos no painel. `app/routes/app.reports.jsx:282-283` diz "nada é despublicado automaticamente ainda", e isso fica falso quando a funcionalidade entrar.
- **Ponto 1, escrita na loja.** O briefing 17/09 `:24` proíbe `productUpdate`. A despublicação de produto precisa de uma mutação fora desse conjunto, ou de emenda explícita a `:24`. Decidir antes da implementação.
- **Ponto 2.** Leituras em produção herdam a janela da Decisão 28 (`:98`): nenhuma sessão `fly ssh` com Prisma durante uma corrida de publicação, incluindo a medição em paralelo da secção 6 do relatório. `db:push` não entra neste ponto. É escrita de schema e fica sob a regra de deploy (`README.md:70`). Os environments `production` de `.github/workflows/deploy.yml:10-11` e `maintenance.yml:14, 85-87` têm revisores configurados fora do repo.
- **Ponto 3.** O `--execute` decide-se só por `args.includes` (`scripts/catalog/tags-cleanup.js:40`, `scripts/catalog/character-pages-sync.js:39`). O OK do arquiteto não tem mecanismo no código nem registo de aprovação. Falta decidir quem é o arquiteto e como o OK fica registado.
- **Ponto 4.** O marcador `metadata.deletedInAdmin` existe, mas nenhum caminho de publicação o lê. Um SKU PUBLISHED sem produto na Shopify não tem o marcador (caso PR6, `docs/PROJECT-TODO.md:214`). Falta decidir o que conta como "apagado na loja". A escalada para P0 é exceção ao critério de severidade do briefing (corromper dados ou derrubar a app). Fica registada aqui. Os produtos apagados e os PENDING daí resultantes não são defeito. O publish deles é (relatório, secção 5).
- **Ponto 5.** DBG-02, como escrito no relatório ("arranque aborta com erro"), repete o crash-loop da Decisão 13 com o `&&` do `Dockerfile:36`. O arranque não pode sair com erro. Retirar `prisma db push` de `lib/prisma/prismaSafe.server.js:85`, que a Decisão 13 proíbe em runtime. O estado degradado de DBG-01 não pode ser um fallback silencioso (`prismaSafe.server.js:38-44`, Decisão 30). Não há teste para o ramo de corrupção nem runbook de restauro no repo. "Suíte local verde" quer dizer as suítes de `.github/workflows/tests.yml:33-43`, não as 71 de `scripts/tests`.
- **Ponto 6.** `Blister` não está no vocabulário de 11 valores de `alterpop.format` decidido a 29/09 (`lib/importer/catalog/formatExtractor.server.js:23-37`, travado por `scripts/tests/format-extractor.test.js:35` e por `lib/importer/catalog/formatBackfillPlan.js:7`). Acrescentá-lo obriga a alterar essa decisão. O invariante de títulos distinguíveis só é garantido por `resolveTitleCollisions` (`titleCleaner.server.js:293`), e nenhum caminho de escrita o usa. Tem de ser ligado ao ingest (`catalogProducts.server.js:56`) e ao `title-clean-dryrun --execute` (`scripts/catalog/title-clean-dryrun.js:178`) antes de qualquer escrita. Produtos já publicados com "Blister 4 figures" (FUNKO, hoje "Vinyl Figure") passam por backfill de `alterpop.format`, que cai na regra de `--execute`. `stripFormatPrefix` entra na camada 2 da franquia (`franchiseResolver.server.js:289`). O dry-run tem de medir mudanças de franquia e de line, não só títulos (`scripts/catalog/title-prefix-restore-dryrun.js`).

**Pendentes de registo:**
- Decisão 13 (schema muda só por passo manual de deploy, nunca no arranque nem em runtime). Vive só em comentários de `Dockerfile:25-29` e `prisma/schema.prisma:112-117`. Registar.
- Tarefa 32 (linha 12 deste ficheiro) diz que `FORMAT_PREFIXES` ficou com `Assorted` e `Latino`. O averbamento de 14/09 (`franchiseResolver.server.js:28-43`) reverteu isso em código, sem registo. Corrigir a linha 12.
- `docs/PLANO-normalizacao-franquias.md:434-436` ("vocabulário fechado") e `lib/importer/shopify/franchiseMetafieldDefinition.js:100` (descrição de `alterpop.format`) estão desatualizados. Atualizar com o ponto 6.
- Scripts com texto "aplicar só depois do OK do Carlos" (`scripts/catalog/curation-mark-deleted.js:12`, `price-reconcile-dry-run.js:6` e `:127`, `last-price-write-backfill.js:13`, `price-reconcile-apply.js:7`). Atualizar com o ponto 3.

**Referência cruzada:** Decisões 13, 21, 28, 30 e 32, relatório `docs/relatorios/debug-geral-14-10-2026.md`, briefing `docs/briefings/arranque-character-17-09-2026.md`.

---

## Decisão 34 — pré-requisitos do Lote 0 e respostas do arquiteto

**Data:** 2026-10-14
**Estado:** fechada pelo arquiteto. Implementação em curso neste branch.
**Origem:** respostas do arquiteto às perguntas da Decisão 33.

**Lote 0**
> 1. **DBG-02.** `ensure-clean-db` deixa de apagar e deixa de sair com erro. Em corrupção grava a flag `DB_DEGRADED` no volume e sai com 0. A app arranca em modo degradado e evita o crash-loop.
> 2. **DBG-01.** `prismaSafe` deixa de apagar ficheiros e deixa de correr `prisma db push`. Em corrupção grava a mesma flag e lança erro visível.
> 3. **Modo degradado.** Bloqueia publish, sync de stock, escrita na fila e escrita na BD. O painel mostra banner vermelho com a causa. Nenhum fallback silencioso.
> 4. **Saída do modo.** Um script de restauro corre com `--execute` e OK do arquiteto. O script apaga a flag só depois de `PRAGMA integrity_check` dar `ok`.
> 5. **Suíte verde.** As quatro suítes de `.github/workflows/tests.yml` (`test:franchise`, `test:sync-safety`, `test:health-gate`, `test:deploy`) mais o teste novo de cada defeito.

**Respostas**
> 6. **DBG-16, regra de escrita.** A regra de `:24` mantém-se. A despublicação usa `publishableUnpublish` no canal Online Store e não toca em título, preço ou categoria.
> 7. **DBG-16, gatilho.** O SKU publicado falta do feed em 2 ciclos seguidos. O código atual usa 3 (`skuLifecycle.server.js:48`). A mudança entra no Lote 2.
> 8. **DBG-16, guarda.** O ciclo aborta e avisa se faltarem mais de 5% dos publicados de uma vez, porque isso indica feed truncado.
> 9. **OK do arquiteto.** O arquiteto é o chat de arquitetura do projeto. O developer entrega o dry-run com contagens. O Carlos passa-o ao arquiteto, e a resposta volta pelo mesmo caminho.
> 10. **Registo do OK.** Cada `--execute` fica em `docs/execucoes.md` com data, comando, contagens do dry-run e referência ao OK. A linha é escrita antes da corrida.
> 11. **DBG-10, vocabulário.** O vocabulário de `alterpop.format` ganha "Blister". O teste `format-extractor.test.js` passa de 11 para 12 valores.
> 12. **DBG-10, invariante.** Verificado em 14/10: `resolveTitleCollisions` não é chamado em nenhum caminho de escrita (`catalogProducts.server.js:56` usa só `cleanProductTitle`). O developer confirma também se correu no ingest desde o PR #68. Se não corre, ligá-lo é pré-requisito do DBG-10.
> 13. **DBG-10, execução.** Dry-run com contagem de títulos afetados e de colisões antes do OK do arquiteto.
> 14. **PUBLISHED sem produto na Shopify.** Contam como apagados para a escalada P0 do DBG-03.
> 15. **DBG-21 (novo).** Entra no Lote 2. O reconciliador marca `deletedInAdmin` quando o produto falta na Shopify e devolve o item a PENDING pela regra de 09/10.
> 16. **Decisão 13.** Registada acima, porque o Lote 0 depende dela.

**Pendentes abertos da revisão adversarial do Lote 0 (14/10)**
- `db:push` e `migrate deploy` correm por CLI e não passam pelas guardas da app. Decidir se o restauro exige a flag limpa antes de qualquer `db:push`.
- Scripts operacionais com mutações Shopify que não tocam na BD (`scripts/catalog/shopify-products-purge.js`, `price-reconcile-apply.js`, entre outros) não têm guarda própria. Decidir se entram.
- `app/routes/wishlist.jsx` escreve metafields de cliente na Shopify. Fora da lista da Decisão 34. Decidir.
- `resetCorruptedQueueToEmpty` (`lib/curation/curationQueue.server.js`, anterior a este lote) substitui a fila por uma vazia quando o JSON não recupera, com backup. A app continua sem aviso. Achado novo, proposto como DBG-22, P1.
- Com o JSON da fila corrompido em modo degradado, a leitura da fila falha à vista. Confirmar que é o comportamento pretendido.
- Falha ao gravar a flag no arranque sai com código 1, para não arrancar com escritas abertas. A alternativa é arrancar sem flag. Confirmar.

**Documentação pendente**
- `docs/FLY-STAGING.md`, `README.md:65`, a linha 157 do briefing 17/09 e os textos dos scripts que pedem OK do Carlos vão num PR só de documentação. Esse PR não bloqueia o Lote 0.

**Ordem**
1. Registar a Decisão 13 e esta decisão (feito neste commit).
2. Entregar DBG-02 e depois DBG-01, cada um com teste.
3. Fazer deploy e confirmar o portão verde.
4. Passar ao Lote 1.

**Referência cruzada:** Decisões 13, 28, 30, 33; relatório `docs/relatorios/debug-geral-14-10-2026.md`.

---

## Decisão 35 — respostas do arquiteto ao plano do PR 2b

**Data:** 2026-10-15
**Estado:** fechada pelo arquiteto. Implementação nos PRs 2b-1, 2b-2 e 2b-3.
**Origem:** plano `docs/planos/plano-2b.md` (secção 11) e relatório `docs/relatorios/debug-geral-14-10-2026.md` (secção 9, DBG-37 a DBG-39).

**Já aceites, confirmadas aqui:** D1 (IPC, o principal é o único escritor), D2 (decisão humana ganha, com `statusChangedAt`), D6 (o worker não muda estado de APPROVED, PUBLISHED nem SYNC_ERROR; a leitura com regras do ponto 3 abaixo completa a frase), D30 (o `|| true` do WAL sai como DBG-37), D31 (a Decisão 34 mantém-se: leituras passam em modo degradado) e DBG-25 com as três condições do plano.

**Escritores e indexação**

1. D3. Reset e purga elite recusam com 409 enquanto houver indexação. As escritas de fila deles passam pelo escritor único.
2. D4. Sem bloqueio na UI. A correção é o PR 2b-1.
3. D7. Scripts que escrevem a fila recusam se houver indexação ou publicação em curso. O risco residual fica aceite, porque são manuais e raros.

**Estados da fila**

4. D9. Reconciliador automático por ciclo, com prova por `product(id)` e aborto acima de 5 %. Arranca só a reportar. Passa a escrever depois de uma semana de relatórios coerentes, com OK do arquiteto.
5. D10. Uma aprovação nova limpa `deletedInAdmin` e permite publicar.
6. D11. SYNC_ERROR só sai pelas três transições manuais da Decisão 29. Marcação de apagados, migração, reset e revert deixam-no como está e listam-no no relatório.
7. D12. A aprovação em massa de apagados fica como está. A confirmação mostra quantos apagados vão na seleção.
8. D13. PUBLISHED sem `shopifyProductId` recebe a marca só se a pesquisa por SKU der vazio em dois ciclos seguidos.
9. D15. Regra de 09/10: um item marcado `deletedInAdmin` fica em PENDING, nunca em APPROVED. Volta a APPROVED só por aprovação humana nova.
10. D44. O caminho de `revertAllPublishedInQueue` que põe SYNC_ERROR em PENDING sai. O reset deixa SYNC_ERROR intacto e lista-o no relatório.

**Restauro**

11. D18. O ponto 4 da Decisão 34 passa a exigir que a fila lê sem erro.
12. D19. Fila sanitizável recusa.
13. D20. Fila em falta recusa, salvo primeiro arranque com catálogo vazio, como no bootstrap.
14. D21. A fila faz parte do snapshot. O restauro repõe os dois e compara contagens.
15. D22. O dry-run recusa com fila corrompida. A verificação corre também sem flag. O restauro recusa com indexação ou publicação em curso.
16. D23. `db:push` exige flag limpa. A leitura da fila em modo degradado falha à vista.
17. D24. `restore_dry_run` copia também `curation-queue.json` e aponta `CURATION_DATA_DIR` para a cópia.
18. D25. `restore_dry_run` lê o estado real da flag, com UNKNOWN em RC=2.
19. D26. Cópia por `VACUUM INTO` na máquina, fora de corridas de publicação. O developer confirma que a ferramenta existe na imagem.
20. D27. `restore_dry_run` espera pela indexação, como `db_push`.
21. D28. Flag sintética na cópia.
22. D29. Ramo degradado que não corre é RC=1. O ponto de injeção fica aceite.
23. D33. Reinício da máquina obrigatório no fim do restauro, dentro do mesmo OK.

**Reset**

24. D35. Para na primeira falha de gravação local.
25. D36. A guarda fica dentro de `runShopifyCatalogReset`.
26. D37. Loja vazia corre a varredura só se a segunda leitura confirmar zero produtos.
27. D38. Três falhas seguidas abortam.
28. D39. Batimento com expiração automática ao fim de 10 minutos sem sinal.
29. D40. Gravação por produto.
30. D42. O ciclo agendado salta a publicação enquanto houver reset em curso, e regista o salto.

**Pendentes do PR 2b-1 (revisão de `37bab0e`, decisões de 16/10/2026)**

1. D2 no reset. Fica como DBG-72, para o PR 2b-3. O reset continua proibido em produção até lá. Sem código.
2. Lista de scripts D7. Bloqueia. Os seis scripts apontados pela lente já chamam `recusarSeAtividadeApp` no início de `main` ou no nível do módulo: `run-approved-sync.js`, `verify-post-ai-removal.js`, `catalog-purge-reindex.js`, `price-reconcile-apply.js`, `curation-spot-check.js` e `stream-import-dry-run.js`. Ao todo são 18 escritores com guarda. O teste `curation-atividade-app.test.js` corre os 18 com marcador vivo. `stream-import-dry-run.js` grava a fila mesmo com `dryRun=true`: DBG-73, para o PR 2b-2.
3. D6 literal. Aceita a leitura com regras. PENDING sem decisão humana continua governado por AUTO_APPROVE e AUTO_REJECT, e um item novo pode nascer APPROVED ou REJECTED pela regra. Sem código. Esta leitura substitui a frase de `plano-2b.md:430` ("Só cria itens PENDING novos e atualiza metadados").
4. D5 de ponta a ponta. Não confirmado. O checkpoint avança em `catalog-index-worker.mjs:65-71`, depois de o flush ser confirmado em `syncCatalogWithProgress.server.js:82-85`. Sem código.
5. Purga de elite. Fica como DBG-43, para o PR 2b-2. Continua proibida em produção. Sem código.
6. Custo no lock. Uma linha de log por lote no processo principal: `[fila] lote de N itens em X ms`, só com números. A medição fica para a primeira importação real, em `logs_recent`.

**Exceção elite.** Um item com origem `elite` desfeito pelo undo não ganha `statusChangedAt`, como a origem `regra`. O recálculo da elite é das regras, não de decisão humana. A origem `reset` segue a mesma regra. Testes U2 e U3 em `scripts/tests/curation-undo-marca-origem.test.js`. Commit `df09a9e`.

**Decisão 7, publicação do ciclo (PR 2b-1, DBG-69).** O ciclo só publica com estado `completed` e `totalRows > 0`. Qualquer outro caso recusa com a marca `[ciclo] publicação recusada` e o motivo: o estado, o erro ou `indexação sem linhas`. Esta Decisão 7 é a da publicação do ciclo. Não é a D7 da lista acima, que é dos scripts. Commit `220e6fc`.

**Decisões do developer, aceites**

D5, D8, D14, D16, D17, D32, D41, D43 e D46, como ficaram na secção 11 do plano.

**Registo**

A regra de não correr o reset em produção mantém-se até o PR 2b-3 estar em produção.

**Referência cruzada:** Decisões 13, 28, 30, 33 e 34; plano `docs/planos/plano-2b.md`; relatório `docs/relatorios/debug-geral-14-10-2026.md`.

## Decisão 36 — veto ao reindex completo até ao 2b-3

**Data:** 2026-10-17
**Estado:** fechada pelo arquiteto. Vale até o PR 2b-3 estar em produção.
**Origem:** DBG-155 em `docs/relatorios/debug-geral-14-10-2026.md`.

`scripts/catalog/full-catalog-reindex.js` não corre em produção, nem com `RESUME=1`. Motivo: escreve o estado da app sem marcador de atividade e sem lock, e pode deixar `running` com `indexing: true` no ficheiro de estado. Isso bloqueia o db:push e impede a retoma.

O veto fica ao lado do de `scripts/catalog/run-approved-sync.js` (DBG-142). Esse veto está registado em `docs/execucoes.md`, e não neste ficheiro. Os três (reindex completo, `run-approved-sync.js` e reset) ficam proibidos em produção até ao 2b-3.
