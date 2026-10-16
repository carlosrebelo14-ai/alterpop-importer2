# Relatório de debug geral — alterpop-importer2

Data: 14/10/2026. Branch: `claude/ecstatic-galileo-v1agy7`. Base: `f377cb1`.
Modo: diagnóstico. Nenhuma correção aplicada. Nenhuma escrita em produção.
Atualizado em 15/10/2026: afirmações corrigidas (secções 4, 8 e 9), DBG-21 com linha própria na secção 4, DBG-37 a DBG-39 na secção 9, e secção 11 com o estado do PR 2a em produção.

## 1. Estado no momento da sessão

| Item | Estado |
|---|---|
| Portão de saúde (`catalog:health`) em produção | Não medido. Este ambiente não tem acesso à Fly, à BD de produção nem à sessão Shopify. |
| `franchise:conditions-diff` em produção | Não medido. Mesma causa. |
| Logs da Fly, últimas 72 h | Não lidos. Mesma causa. |
| Suites de teste locais | 71 ficheiros. 70 com saída 0. 934 asserções `ok`. Única falha: `test-indexing-radar-e2e.js`, que exige `OCIOSTOCK_FEED_URL` (segredo). |
| `tsc --noEmit` | Saída 0. |
| `react-router build` | Saída 0. |
| Lint (`eslint lib app scripts`) | 612 problemas. Não corre no CI. Ver DBG-18. |

## 2. Cobertura

| Área | Como foi verificada | Resultado |
|---|---|---|
| 1 Ingest OcioStock | Leitura do parser e do mapeador. Probe com CSV sintético. | DBG-07, DBG-08, DBG-19 |
| 2 Resolvers | Suite `franchise-resolver`, `character-resolver`, `manufacturer-*`. Leitura parcial. | Verdes. Não revistos em profundidade. |
| 3 Limpador de títulos | Probe com títulos de padrão de feed. | DBG-10 |
| 4 Fila de curadoria | Leitura das transições. Probe de aprovação sobre fila sintética. | DBG-04, DBG-11 |
| 5 Publisher | Leitura de `api.shopify-sync`, `shopifyApprovedSync`, guardas. | DBG-03, DBG-05 |
| 6 Preço | Leitura de `pricing.server.js` e suite `pricing.test.js`. | Sem defeito. Não re-medido numericamente. |
| 7 Ciclo de sync | Leitura de `trigger-sync`, `publishedStockSync`, `skuLifecycle`. | DBG-05, DBG-09, DBG-16 |
| 8 Portão de saúde | Leitura integral de `pre-pilot-verify.js`. Não executado contra a loja. | DBG-06, DBG-12, DBG-13 |
| 9 Infra | Leitura de `Dockerfile`, `fly.toml`, `ensure-clean-db.js`, `prismaSafe`, `db.server.js`. | DBG-01, DBG-02, DBG-14, DBG-15 |
| 10 Painel UI | Build. Varredura de `catch` vazios. Sem browser (precisa de sessão Shopify). | DBG-17 |

Varredura de `catch` vazios: 13 em `scripts/**` (só `$disconnect`, sem impacto), 1 em `lib/curation/curationQueue.server.js:236` (só logging, intencional), 1 em `app/routes/app._index.jsx:589` (DBG-17).

## 3. Incidentes desta sessão

- Um probe escreveu `server/data/curation-queue.json` (gitignored) com SKUs sintéticos `SYN-PUB`, `SYN-ERR`, `SYN-DEL`. Remover: `rm server/data/curation-queue.json`.
- As suites de teste criaram `data/` na raiz (gitignored). Remover: `rm -rf data`.
- Depois da tentativa de remoção, o classificador bloqueou o Bash da sessão. Os dois ficheiros acima não foram removidos.
- O branch designado não existia no remoto. Foi criado a partir de `main` em `f377cb1`, o mesmo commit base local. Este relatório foi publicado pela API do GitHub, sem commit local.

## 4. Defeitos

Ordem: severidade, depois ID. P0 corrompe dados ou derruba a app. P1 bloqueia fluxo ou publica sem decisão. P2 falha em silêncio ou degrada resultado. P3 cosmético ou dívida.

| ID | Sev | Área | Sintoma | Causa provável | Reprodução | Correção proposta | Teste proposto | Estado |
|---|---|---|---|---|---|---|---|---|
| DBG-01 | P0 | Infra / prismaSafe | Em runtime, um erro com assinatura de corrupção apaga `dev.sqlite`, `-wal` e `-shm` e recria o schema com `prisma db push`. A app segue sobre BD vazia, sem aviso. | `backupAndRestoreDatabase` (`lib/prisma/prismaSafe.server.js:52-90`), chamado por `safePrisma` (`:40`). Sem mutex: queries falhadas em paralelo disparam backups e remoções em cadeia. O PriceHistory (Omnibus) vive no mesmo ficheiro. | Forçar `database disk image is malformed` num `safePrisma` sobre cópia de `dev.sqlite`. | Retirar o apagão. Em corrupção, pôr a app em estado degradado que bloqueia publish e escrita, à espera de decisão do Carlos. Restauro só com aprovação. | Injetar erro de corrupção. Verificar que `unlinkSync` e `execSync` não correm e que publish fica bloqueado. | Em produção, SHA `d1a205b` (Lote 0). |
| DBG-02 | P0 | Infra / arranque | Com corrupção no boot, `ensure-clean-db` faz backup, remove o ficheiro e não recria o schema. `npm run start` arranca sobre BD sem tabelas. | `scripts/setup/ensure-clean-db.js:25-66`, chamado em `:66`. O `db push` saiu do arranque pela Decisão 13, mas o ramo de remoção ficou. | Ficheiro corrompido em `/app/data`. Correr `node scripts/setup/ensure-clean-db.js` e depois `npm run start`. Esperado: `no such table`. | Arranque aborta com erro visível em vez de apagar. Restauro explícito e aprovado. | Fixture com SQLite corrompido. Script sai com código diferente de 0 e não remove nada. | Em produção, SHA `d1a205b` (Lote 0). |
| DBG-03 | P1 | Publisher / aprovação | Publica SKUs que não estão `APPROVED`. Se nenhum SKU pedido estiver aprovado, publica todos os pedidos. Se só parte estiver aprovada, a parte restante desaparece sem aviso. Sobe a P0 se o SKU for produto que o Carlos apagou na loja. | `api.shopify-sync.jsx:117-121` (fallback `approvedSkus = requestedSkus`) e `shopifyApprovedSync.server.js:102-106` (fallback `[...requestedSet]`). A UI envia `selectedSkus` sem filtrar estado (`app/routes/app._index.jsx:1562`). | Selecionar um SKU PENDING ou REJECTED na grelha e publicar pelo painel de staging. Ou `POST /api/shopify-sync` com `skus` de SKUs não aprovados. | Remover os dois fallbacks. SKU fora de `APPROVED` devolve 400 com a lista de SKUs e estados. | `POST` com SKUs PENDING, REJECTED e PUBLISHED não chama `publishCatalogProductToShopify`. | Em produção, SHA `58a99fe` (Lote 1, PR #104). Verificação pós-deploy na secção 10. |
| DBG-04 | P1 | Fila de curadoria | Escritas perdidas entre processos. Aprovações feitas durante a indexação podem ser apagadas. Um flush do worker pode repor uma cópia antiga da fila. | O lock (`curationQueue.server.js:74-82`; a linha :71 é só comentário) existe só em memória do processo. O worker é `fork` (`indexingStream.server.js:149`) e grava com `flushCurationQueueItems` (`syncCatalogWithProgress.server.js:182`), a partir de uma cópia tirada no arranque (`:144`). O principal faz read-modify-write com `saveCurationQueue` (`curationQueue.server.js:331-348`). Escritores fora do lock: `shopifyReset.server.js:226-301`, `eliteCuration.server.js:179-210` e `recoverCorruptedQueueJson` (`curationQueue.server.js:262`). | Aprovar um SKU pela UI enquanto corre a indexação, e ver se o estado persiste depois do flush. Um save do principal reescreve também o ficheiro com a cópia que leu antes. | Escritor único: o worker envia alterações por IPC e o principal aplica-as dentro do lock. Um lockfile sem IPC não chega. Decisões D1, D2 e D6 do arquiteto (PR 2b-1). | Dois processos `fork` a alternar atualizações, e uma cópia obsoleta a não sobrescrever uma decisão humana. | Confirmado por código. Frequência por medir nos logs (`[indexacao]` e `logs_recent`). |
| DBG-05 | P1 | Stock de publicados | Stock escrito na location errada quando as definições têm `locationId` diferente da location primária. | `api.trigger-sync.jsx:222` chama `syncPublishedStockLevels` sem `locationId`. A função usa env ou a location primária (`publishedStockSync.server.js:57`). O publisher usa `cfg.import.locationId` primeiro (`shopifyApprovedSync.server.js:197`). | Definir `locationId` nas definições com location não primária. Correr `trigger-sync`. Ver em que location muda o inventário. | Um helper único de resolução de location, usado pelo publisher e pelo sync de stock. | Com `locationId` nas definições, `syncPublishedStockLevels` escreve nessa location (cliente mock). | Confirmado no código. Impacto depende da definição em produção. |
| DBG-22 | P1 | Infra / curadoria | Fila de curadoria que não recupera reinicia com fila vazia, sem aviso. Um escritor grava essa fila por cima do ficheiro original. | `resetCorruptedQueueToEmpty` em `lib/curation/curationQueue.server.js`, chamado por `readAndCacheQueue` quando `recoverCorruptedQueueJson` devolve null. | JSON inválido sem caracteres de controlo em `curation-queue.json`. | Backup, flag `DB_DEGRADED` com a causa e leitura recusada. Painel abre com banner. Fila em falta: vazia só sem catálogo na BD. | `scripts/tests/curation-queue-guards.test.js`. | Em produção, SHA `58a99fe` (Lote 1, PR #104). Verificação pós-deploy na secção 10. |
| DBG-21 | P1 | Curadoria / publicação | Leitura da Shopify que falha vira "SKU não existe", e pode levar à criação de produto duplicado. Itens com produto apagado na loja recebem `deletedInAdmin` sem prova por `product(id)` no sweep do reset, que se faz a partir de uma só listagem. | `resolveSku.js:69-74` engole erros e guarda `null` em cache. Chamadores: `shopifyProductPublisher.server.js:184` e `:322-354`, `ProductImporter.js:532-536`, `InventoryImporter.js:55-59`, `publishedStockSync.server.js:89-95`. Sweep sem prova por id: `shopifyReset.server.js:241-244` e `:469-475`. `markQueueItemDeletedInAdmin` (`curationQueue.server.js:1176-1187`) aceita SYNC_ERROR e REJECTED como origem. A regra de 09/10 é referida em `docs/decisoes.md:264` e `:227`, mas o seu conteúdo não está escrito. Não existe ciclo automático de reconciliação: só há ações manuais (`publishedReprice.server.js:243-254`, `scripts/catalog/curation-mark-deleted.js`). | Ler a Shopify com falha simulada e ver se o item vai para SYNC_ERROR ou se cria produto. Verificar na loja se já houve duplicados (leitura, sem escrita). | Erro de leitura nunca vira "não existe" nem criação (Decisão 30). A marca `deletedInAdmin` só com prova por `product(id)`, e só a partir de PUBLISHED. Decisões de estado D9 a D13 e D16 sobem ao arquiteto antes do PR 2b-2. | Cliente Shopify que lança; sweep sem `pageInfo`; origem SYNC_ERROR recusada. | Confirmado por código. Duplicado na loja não verificado. Severidade do publicador em DBG-39. |
| DBG-06 | P2 | Portão de saúde | O portão fica verde sem nenhum ciclo ter corrido. V13, V14, V15 e V17 passam com "sem estado". | `pre-pilot-verify.js:509, :542, :573, :635` usam `info()`, que tem nível `pass`. | Correr `catalog:health` sem estado de ciclo gravado. Ver `allPass`. | Sem estado após N horas, nível `warn` ou `fail`. | Portão com estado ausente não devolve verde. | Confirmado por leitura. |
| DBG-07 | P2 | Ingest CSV | Campo entre aspas com quebra de linha parte o registo. O produto perde custo, PVPR e stock, e aparece um SKU fantasma. | `streamCsv.js:109` lê linha a linha e não junta linhas de campo aspado. Probe: o produto A2 fica com `distributorPrice` null e stock 0. Surge o SKU `quebra de linha;5,00;7,00;2;SI`. | CSV sintético de 3 produtos, com quebra dentro de descrição aspada. Resultado: 4 registos e um SKU fantasma. | Parser com estado entre linhas. Contar registos contra linhas de dados e recusar o lote se não bater. | Fixture em `scripts/tests`: 3 registos e zero SKU fantasma. | Confirmado no parser. Frequência no feed real por medir. |
| DBG-08 | P2 | Ingest / indexação | A indexação grava linhas sem preço nem stock. O ciclo não compara o total com a corrida anterior. A deteção de queda só existe em V5, horas depois. | `syncCatalogWithProgress.server.js:218-225` não chama `validateRecord`. Esse validador só é usado em `core/streamImport.js:123`, o importador legado. | Linha sem `precio_distribuidores` no CSV. Resultado: entra no batch. | Rejeitar com motivo `sem_custo` via `recordCatalogRejection`. Check de queda de total antes do publish. | Linha sem custo gera `recordCatalogRejection` e não entra no batch. | Confirmado por leitura. |
| DBG-09 | P2 | Stock de publicados | Erro de leitura do catálogo virava "sem alteração" em todos os SKUs, sem falha contada. | Antes, `publishedStockSync.server.js:53` usava `fallback: []` na leitura do catálogo. Hoje a leitura está em `loadPublishedStockRows` (`:37`), com `rethrow: true`. O chamador regista a falha no registo de sync (`api.trigger-sync.jsx`). | Query que lança. Antes: `skipped` = total e `failed` = 0. | `rethrow: true`, como no publisher (Tarefa 51). | Query que lança faz o ciclo devolver erro e fica registada no registo de sync. | Em produção, SHA `8960cf6` (PR #105). Teste `scripts/tests/published-stock-read-safety.test.js`. |
| DBG-10 | P2 | Limpador de títulos | Prefixos empilhados acima de 3 deixam resíduo sem sinal. "Blister" não está em `NOISE_PREFIXES`, e isso trava a cadeia de prefixos. | `titleCleaner.server.js:112` (`MAX_PASSAGENS_PREFIXO = 3`). Probe: `Assorted` ×4 + `Naruto Sasuke` dá `Assorted Naruto Sasuke`. `Pocket POP Keychain` ×4 deixa resíduo. `prefixoTravaoMinimo` fica `false`. Com `Assorted Blister Pocket POP Keychain Rides POP figure Naruto Sasuke` sobra `Blister Pocket POP Keychain Rides POP figure`. | `cleanProductTitleWithTrace` com os títulos acima e `resolvedFormat` = `Keychain`. | Marcar `prefixo-travao` no trace e mandar o título para revisão. Decidir se "Blister" é prefixo de formato. | Os casos acima com resultado esperado e a flag. | Confirmado por probe. |
| DBG-11 | P2 | Curadoria / transições | `approveProduct` e o setter em massa aceitam PUBLISHED e passam para APPROVED. Um item vivo fica marcado como aprovado pendente. | `approveProductLocked` (`curationQueue.server.js:617-649`) e `bulkSetQueueStatusLocked` (`:713-760`) não têm guarda de estado. A UI em massa usa `bulkTransitionPending`, que tem guarda. | Probe: `SYN-PUB` PUBLISHED, `approveProduct` → APPROVED. | `approveProduct` recusa PUBLISHED. O setter em massa fica só para scripts com lista explícita. | `approveProduct` sobre PUBLISHED devolve erro. | Em produção, SHA `58a99fe` (Lote 1, PR #104). Verificação pós-deploy na secção 10. |
| DBG-12 | P2 | Portão de saúde | As definições do B7 não são verificadas. `alterpop.character` e `alterpop.characters` faltam na lista `EXPECTED_METAFIELD_DEFS`. | `pre-pilot-verify.js` perto de `:455-461`. | Remover uma definição numa loja de teste e correr o portão. | Acrescentar as duas com tipo `list.metaobject_reference`. | Portão com definição em falta dá `fail`. | Confirmado por leitura. |
| DBG-13 | P3 | Portão de saúde | O limiar V8 é o número fixo 35. Hoje coincide com 34 universos ativos mais 1 linha. Ativar um dormente ou acrescentar uma linha dá vermelho sem problema real. | `pre-pilot-verify.js:438`. Tabela: 39 universos, 34 ativos, 5 dormentes, 7 `closed`. `franchiseLines.js` tem 1 linha. | Ativar um dormente num ambiente de teste. | Derivar do número de universos ativos e de linhas. | Teste unitário com tabela sintética. | Confirmado por leitura e contagem. |
| DBG-14 | P2 | Infra / memória | A VM da Fly não tem configuração de memória. O heap do Node pode ir até 1024 MB. O OOM de 09/10 já está documentado no código. | `fly.toml` sem `[[vm]]`. `Dockerfile:9` com `--max-old-space-size=1024`. | `flyctl scale show -a alterpop-importer-app` e métricas de memória. | `[[vm]]` com memória explícita, e heap ajustado à VM. | Verificação no checklist de deploy. | Suspeita. Por medir. |
| DBG-15 | P2 | Infra / SQLite | PRAGMAs são por ligação. O watchdog faz `$disconnect` com queries em voo. Uma ligação reaberta por query implícita não recebe WAL nem `busy_timeout`. | `app/db.server.js` (`startPrismaConnectionWatchdog`) e `lib/prisma/configureSqlite.server.js`. O aviso "Falha ao configurar PRAGMAs SQLite" aparece nos logs dos testes sem `DATABASE_URL`. | Medir `database is locked` nos logs Fly. Verificar se o PRAGMA corre em cada ligação. | Aplicar PRAGMAs no momento da ligação, não só no bootstrap. | Teste que conta ligações novas sem PRAGMA. | Suspeita. Por medir. |
| DBG-16 | P2 | Decisão do Carlos | O briefing da sessão (área 7 do âmbito) diz "despublica descontinuados com aviso". A frase não está no repo. O código marca-os "para revisão" (`skuLifecycle.server.js:256`) e o sync de stock salta-os sem aviso. Não há despublicação. | Divergência entre briefing e código. | Ciclo com SKU publicado ausente do catálogo. | Confirmar se a spec pede despublicação. Se sim, passo próprio com dry-run e aviso. | Depende da decisão. | Pergunta aberta. |
| DBG-17 | P3 | Painel | `catch` vazio no stream de indexação do painel. Falhas de parse ficam sem aviso e a UI pode ficar parada. | `app/routes/app._index.jsx:589-591`. | Enviar JSON inválido ao stream. | Mostrar aviso e reabrir o stream. | Componente com stream corrompido. | Confirmado por leitura. |
| DBG-18 | P3 | Qualidade / lint | 612 problemas. 487 são `no-undef` (`process`, `Buffer`, `__dirname` sem ambiente node). 62 `react/prop-types`, 36 `no-unused-vars`, 13 `no-empty` nos scripts. O lint não corre no CI. | `.eslintrc.cjs` e `.github/workflows/tests.yml`. | `npx eslint --quiet lib app scripts`. | Ambiente node no config. Lint no CI depois da limpeza. | Lint no CI. | Confirmado. |
| DBG-19 | P3 | Ingest / NFC | O ingest não normaliza NFC. Os resolvedores normalizam só na comparação. Facetas com NFD podem duplicar valores iguais no ecrã. | `csvFieldMap.js` e `streamCsv.js` sem `normalize("NFC")`. | CSV com "Pokémon" em NFD e em NFC. Ver facetas. | `normalize("NFC")` no parser. | Fixture NFD. | Suspeita. Por medir. |
| DBG-20 | P3 | Testes | `test-indexing-radar-e2e.js` exige `OCIOSTOCK_FEED_URL`. Falha sem o segredo. Não corre no CI. | `scripts/tests/test-indexing-radar-e2e.js`. | Correr sem a variável. | Marcar como e2e opcional, ou correr no CI com o segredo. | — | Confirmado. |

## 5. Não contam como defeito

Decisões do briefing, não entram na lista:
- Produtos apagados pelo Carlos na loja e os PENDING que daí resultam.
- Margem de 10 % (`MIN_MARGIN`).
- Lista fechada de franquias.
- Universos em rascunho.

## 6. Não executado, precisa de acesso

| Verificação | Comando ou ação |
|---|---|
| Portão de saúde em produção | `flyctl ssh console -a alterpop-importer-app -C "sh -lc 'cd /app && npm run catalog:health'"` |
| Diff de franquias em produção | Mesmo formato, com `npm run franchise:conditions-diff`. |
| Logs das últimas 72 h | `flyctl logs -a alterpop-importer-app --no-tail`. Agrupar por origem. |
| Reconciliador em modo diff | Com a loja real, sem `--execute`. |
| Dry-run aprovar → publicar, 2 produtos sintéticos | Precisa de dev store. |
| Painel no browser, com consola | Precisa de sessão Shopify. |
| Memória da VM | `flyctl scale show -a alterpop-importer-app`. |

## 7. Decisões pedidas ao Carlos

1. DBG-10: "Blister" é prefixo de formato ou fica no título?
2. DBG-16: descontinuados são despublicados, ou só ficam para revisão?
3. DBG-05: confirmar o valor de `locationId` nas definições de produção.

Respostas registadas em 14/10 na Decisão 33 de `docs/decisoes.md`. Pergunta 1: "Blister" passa a prefixo de formato (ponto 6). Pergunta 2: despublica e lista para escolha de substituto (ponto 1). Pergunta 3: a leitura do `locationId` faz-se fora de corridas de publicação (pontos 2 e 3, e notas técnicas da sessão).

## 8. Próximo passo sugerido

Lote 0 (DBG-01, DBG-02) fechado: em produção no SHA `d1a205b`. O Carlos confirmou o painel sem faixa vermelha.

Lote 1 (DBG-03, DBG-11, DBG-22) em produção no SHA `58a99fe`. Portão de catálogo verde na repetição. Ver secção 10.

Lote 2: PR 2a em produção (DBG-06, DBG-09 e DBG-15 parcial, secção 11). DBG-37 em produção no SHA `a9930c9` (secção 11). PR 2b em três PRs: 2b-1 DBG-04 (com DBG-40); 2b-2 DBG-21, DBG-23, DBG-25 e DBG-26; 2b-3 DBG-30. DBG-05, DBG-16, painel e scripts em PR 2c. Depois do lote 2, o portão passa a verificar os defeitos de forma automática, pelo método B18.

Regra de processo até o PR 2b-3: ninguém corre o reset da Shopify em produção enquanto o laço de apagamento não tiver teste (DBG-30). Não é guarda técnica.

## 9. Achados novos: Lote 2 e dívida

Origem: revisão adversarial do Lote 1 (dois ciclos, commits `98105b7` e `fc04a0a`..`ada684e`). Achados confirmados que não entraram no PR #104.

| ID | Sev | Lote | Origem | Achado | Teste previsto |
|---|---|---|---|---|---|
| DBG-23 | P1 | Lote 2 | Revisão Lote 1, ponto 3 (texto da revisão fora do repositório) | O restauro (`restore-db-degraded.js:76-78`) apaga a flag sem verificar a fila. Com a fila corrompida, a app volta a ler a flag na leitura seguinte. O dry-run e a saída "Nada a fazer" saem com 0 sem ver a fila (`:48-51`, `:59-61`). Fila em falta também grava a flag (`curationQueue.server.js:134-169`). | Ainda não existe. Proposta no PR 2b-2: o restauro recusa apagar a flag com fila corrompida ou em falta. |
| DBG-24 | P1 | Lote 2 | Revisão Lote 1, ponto 5 | `getDashboardStats` e `api.products.import-edits` engolem `DB_DEGRADED` e respondem 200. | Respondem 503 com a causa, com teste em modo degradado. |
| DBG-25 | P2 | Lote 2 | Revisão Lote 1, ponto 6 (texto da revisão fora do repositório) | Depois de uma escrita da fila recusada em modo degradado, a cópia em memória fica com a alteração e continua a ser lida, incluindo pela publicação (`curationQueue.server.js:1243`) e pela importação live (`ProductImporter.js:173-178`, `visibilityGatekeeper.js:142-148`). A leitura em cache não é recusada com a flag ativa, e isso é a política da Decisão 34. A cópia suja tem ID próprio, DBG-38. | Ainda não existe. Proposta no PR 2b-2: invalidar a cache depois de escrita falhada, com as três condições do mapa do 2b. Casos (a) a (c) em `scripts/tests/curation-queue-guards.test.js`. |
| DBG-26 | P2 | Lote 2 | Revisão Lote 1, ponto 7 (texto da revisão fora do repositório) | `restore_dry_run` não exercita o ramo degradado na tarefa de CI, porque a cópia do volume não tem a flag. A cópia é de BD viva, sem parar a app nem esperar pela indexação. O WAL é copiado com `|| true` (DBG-37). | Ainda não existe. Proposta no PR 2b-2: flag sintética só na pasta temporária (`mktemp -d`), e a tarefa falha se o ramo não correr. `scripts/tests/restore-db-degraded.test.js` já exercita o ramo em pasta temporária. |
| DBG-27 | P2 | Lote 2 | Revisão Lote 1, ponto 8 | No CSV, a linha com aprovação recusada grava o override de título ou categoria. | A linha é atómica: aprovação recusada descarta o override da mesma linha. |
| DBG-28 | P2 | Lote 2 | Revisão Lote 1, ponto 9 | O painel fica com `decisions` desatualizado depois de recusa com `rejected` e depois de publicar. | O painel recarrega `decisions` após recusa e após publicação. |
| DBG-29 | P2 | Lote 2 | Revisão Lote 1, ponto 11 | O botão "Publicar Aprovados na Shopify" publica todos os APPROVED sem confirmação com a contagem. | Mantém o comportamento. Ganha confirmação com a contagem antes de publicar. |
| DBG-30 | P1 | Lote 2 | Revisão dos commits novos, achado 8 (texto fora do repositório) | O laço de apagamento de `runShopifyCatalogReset` (`shopifyReset.server.js`) não tem teste. Não há cobertura da gravação das falhas: o teste do sweep (`curation-queue-guards.test.js:147-168`) usa listas à mão e não gera falhas. O laço apaga antes de gravar localmente, não para numa falha de gravação local (`:448-461`), e sai cedo com loja vazia (`:389-397`). | Teste do laço com cliente Shopify falso, em `scripts/tests/shopify-reset-loop.test.js` (PR 2b-3). Até lá, sem reset em produção, como regra de processo. Não há guarda técnica: `scripts/catalog/shopify-products-purge.js:57` não lê a flag (DBG-32). |
| DBG-31 | P2 | Lote 2 | Briefing do Lote 2 | Verificado em 15/10 na documentação oficial do `flyctl logs`: as flags confirmadas são `--no-tail` e `--json`. Não aparece `--since` nem flag de número de linhas na referência consultada. A afirmação de 100 linhas não se confirma: a execução `38716387091` leu 3100 linhas. | Feito no PR 2a: resumo por marcadores e janela coberta, com teste em `scripts/tests/logs-summary.test.js`. |
| DBG-32 | P2 | Lote 2 | Briefing do Lote 2 | Os scripts de mutação Shopify não leem a flag. O `db:push` por CLI não tem guarda. | Os scripts recusam com a flag ativa. Guarda no `db:push`, com teste. |
| DBG-37 | P2 | Lote 2 | Mapa do 2b (15/10/2026) | `scripts/ci/maintenance.sh`, tarefa `restore_dry_run`: a cópia do WAL corre com `|| true`. Se falhar, o `integrity_check` diz ok sobre o ficheiro principal, sem as transações pendentes. É um falso ok antes de um restauro real. Não escreve nada na Fly. | Falha de cópia do WAL faz a tarefa falhar com mensagem explícita. WAL ausente aparece separado de falha de cópia. Teste com `flyctl` falso para os dois casos, em PR próprio, antes do 2b. |
| DBG-38 | P2 | Lote 2 | Mapa do 2b (15/10/2026), causa de DBG-25 | Escrita da fila recusada em modo degradado deixa a alteração na cópia em memória, e a cópia continua a ser lida depois de a flag sair. | Invalidar a cache depois de qualquer escrita falhada (PR 2b-2, junto com DBG-25). Teste de `curation-queue-guards.test.js`, casos (a) a (c). |
| DBG-39 | P0 (suspeito) | Lote 2 | Mapa do 2b (15/10/2026), publicador | `shopifyProductPublisher.server.js:322-354` e `resolveSku.js:69-74`: uma leitura falhada durante a publicação de um SKU já existente pode criar produto novo na Shopify, em duplicado. `ProductImporter.js:532-536` tem o mesmo risco. | Verificar na loja se já há duplicados (leitura, sem escrita). Corrigir em DBG-21 parte A. A severidade fica suspensa até a verificação. |
| DBG-40 | P3 | Lote 2 (PR 2b-1) | Verificação pós-deploy do DBG-37, 15/10 | No resumo do `logs_recent`, o último fim de indexação mostra "às -". O fim traz causa, estado e duração, mas a hora não chega ao resumo. Observado na execução `38749758496`, com uma indexação de `ciclo` de 51 s. | A hora do último fim aparece no resumo. Teste em `scripts/tests/logs-summary.test.js` que falha hoje. |

Dívida (sem data de lote):

| ID | Sev | Lote | Origem | Achado | Teste previsto |
|---|---|---|---|---|---|
| DBG-33 | P3 | Dívida | Revisão Lote 1, ponto 10 | `scripts/sync/verify-post-ai-removal.js` imprime "Concluído" quando o pedido é recusado. | Imprime o resultado real e sai com código diferente de 0. |
| DBG-34 | P3 | Dívida | Revisão dos commits novos, achado 4 | `recentErrors` do reset guarda só 50 falhas. `failed` tem o total, mas a lista perde as restantes sem aviso. | Guardar todas, ou devolver o total com a lista truncada e um aviso. |
| DBG-35 | P3 | Dívida | Revisão do Lote 1 (`markDbDegraded`) | Se gravar a flag falhar depois do backup, cada leitura seguinte grava outro backup. | Falha ao gravar a flag lança com a causa, sem novo backup a cada leitura. |
| DBG-36 | P3 | Dívida | Revisão do Lote 1 (testes) | O caso de upsert não reproduz o título que voltava a APPROVED por regra AUTO_APPROVE. O assert cobre só PUBLISHED. | Caso com regra AUTO_APPROVE real, com `rules.json` no fixture. |
| DBG-41 | P2 | Dívida | Verificação pós-deploy do DBG-37, 15/10 | `npm ci` reporta 75 vulnerabilidades (1 baixa, 9 moderadas, 63 altas, 2 críticas). Não há triagem com `npm audit --omit=dev`, por isso não se sabe o que chega à produção. | Triagem com `npm audit --omit=dev` antes do Lote 3. Separar o que é de produção do que é de desenvolvimento. |
| DBG-42 | P3 | Dívida | Verificação pós-deploy do DBG-37, 15/10 | As actions `actions/checkout@v4` e `actions/setup-node@v4` correm em Node 20 forçado para Node 24, segundo o aviso dos runners. | Atualizar para versões que correm em Node 24 nativo, com a CI verde. |

## 10. Verificação pós-deploy do Lote 1 (SHA `58a99fe`)

| Passo | Execução | Resultado |
|---|---|---|
| deploy #17 | [38641116417](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38641116417) | `success`, todos os passos verdes. Aprovado pelo Carlos. |
| `db_flag_check` | [38645292215](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38645292215) | Flag `DB_DEGRADED` ausente. |
| `catalog_health` (1.ª) | [38645752340](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38645752340) | Exit 75: indexação a decorrer nas 15 tentativas (de 22:10:43Z a 22:26:38Z). Portão não avaliado. |
| `catalog_health` (repetição) | [38648011161](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38648011161) | Verde: 16 verdes, 0 vermelhas, 0 avisos. Indexação ainda a decorrer às 22:31:06Z e concluída antes das 22:33:06Z. |
| `db_flag_check` (depois) | [38648514614](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38648514614) | Flag ausente. |
| `logs_recent` | [38648722356](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38648722356) | 100 linhas lidas, 0 `DbDegradedError`, 0 mensagens de modo degradado. |

Duração da indexação observada: a corrida já estava a decorrer à primeira observação, às 22:10:43Z, e ainda decorria às 22:26:38Z, mais de 16 minutos. Terminou entre 22:31:06Z e 22:33:06Z. O início não foi observado. Era anterior a 22:10Z, e o deploy terminou às 21:50Z. A causa do arranque da indexação não foi verificada. Os logs de 100 linhas não mostram erros do worker nem recusas de escrita na fila, mas a janela é curta demais para excluir essas falhas.

## 11. Lote 2, PR 2a em produção (SHA `8960cf6`)

| Item | Estado |
|---|---|
| DBG-06 | Em produção. V13, V14, V15 e V17 sem estado passam a `warn`, e a `fail` ao fim de 24 h sem estado. |
| DBG-09 | Em produção. Erro de leitura do catálogo lança e fica no registo de sync. |
| DBG-15 | Parcial. As PRAGMAs são reaplicadas antes da primeira query depois de cada reconexão. O pool do Prisma continua com várias ligações, e as PRAGMAs de ligação só ficam numa delas. Fechar isto exige `connection_limit=1`, que muda a concorrência da app. Decisão pendente. |
| Observabilidade | `[indexacao]` com causa, modo, estado e duração. `logs_recent` com `flyctl logs --no-tail --json`, e resumo só com contagens e categorias. |

Verificação pós-deploy:

| Passo | Execução | Resultado |
|---|---|---|
| deploy #18 | [38712371816](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38712371816) | `success`, concluído às 09:47:16Z. Aprovado pelo Carlos. |
| `db_flag_check` | [38715913873](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38715913873) | Flag `DB_DEGRADED` ausente. |
| `catalog_health` | [38716080255](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38716080255) | 16 verdes, 0 vermelhas, 0 avisos. |
| `logs_recent` | [38716387091](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38716387091) | 3100 linhas, de 09:22:13Z a 09:54:24Z. 0 `DbDegradedError`, 0 recusas, 0 `database is locked`, 0 reinícios do worker, 0 indexações. |

A janela de 3100 linhas cobre o deploy. Na execução de 14/10 a 15/10, uma indexação concluída (causa `ciclo`, 51 s) foi observada. O marcador de início não está na janela. O resumo ainda mostra "às -" (DBG-40). Os marcadores `[indexacao]` estão parcialmente observados em produção.

### DBG-37 em produção (SHA `a9930c9`)

As quatro execuções correram no `main` em `224c758`. Esse commit só acrescenta documentação a `a9930c9`, por isso o código verificado é o mesmo.

| Verificação | Execução | Resultado |
|---|---|---|
| Deploy `a9930c9` | [38739332525](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38739332525) | `success`, concluído às 14:08:45Z. Aprovado pelo Carlos. |
| `db_flag_check` | [38749459063](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38749459063) | Flag `DB_DEGRADED` ausente. |
| `catalog_health` | [38749608714](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38749608714) | 16 verdes, 0 vermelhas, 0 avisos. |
| `logs_recent` | [38749758496](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38749758496) | 3100 linhas, de 13:48:14Z a 14:15:19Z. 0 `DbDegradedError`, 0 recusas, 0 `database is locked`, 0 reinícios do worker. Uma indexação concluída: causa `ciclo`, 51 s. |
| `restore_dry_run` | [38749860706](https://github.com/carlosrebelo14-ai/alterpop-importer2/actions/runs/38749860706) | `integrity_check` da cópia ok. WAL copiado. |

DBG-37 fica fechado em produção no SHA `a9930c9`.


## 12. Lote 2b-1: lentes sobre `36a9424` (16/10/2026)

Três lentes, uma de cada vez, sobre o diff de `origin/main` a `36a9424` (69 ficheiros). Classificação pelo `git blame`. Só achados de severidade média ou alta causados pelo diff bloqueiam. Os bloqueantes corrigidos no commit seguinte a esta secção: renovação do lock que truncava o ficheiro (lente 1), cache com estado não gravado depois de falha (lente 1), e undo que gravava marca de decisão humana em itens de regra (lente 2).

| ID | Sev | Origem | Local | Achado |
|---|---|---|---|---|
| DBG-51 | Baixa | pré-existente | `curationQueue.server.js:444` | `.tmp` órfão quando a gravação falha com ENOSPC. O `writeFile` do tmp fica fora do `try`. Origem `c5a4645`. |
| DBG-52 | Baixa | pré-existente | `catalogRebuildStatus.server.js:76-106` | Race do ficheiro de estado de indexação: worker e principal fazem leitura-modificação-escrita sem lock. Efeito seguro, o upsert é idempotente. |
| DBG-53 | Baixa | diff | `curationQueueFileLock.server.js` (`libertarSeObsoleto`) | Race do unlink de lock obsoleto: dois titulares podem ficar com o lock. Janela de sub-milissegundo. |
| DBG-54 | Baixa | diff | `curationQueueFileLock.server.js:194-199, 235-247` | Erros de renovação e de libertação engolidos. Se o unlink falhar, o lock fica preso até 10 min. |
| DBG-55 | Baixa | diff | `scripts/catalog/price-reconcile-apply.js:253`, `curation-requeue-deleted.js:147`, `curation-mark-deleted.js:104` | Scripts seguram o lock durante o ciclo inteiro. Aprovações do painel esperam 30 s e devolvem 503 "fila ocupada". |
| DBG-56 | Média | pré-existente | `curationQueue.server.js:72-82` | Espera em processo sem prazo (cadeia `queueLock`). Existe em `origin/main` (`c5a4645`). O diff alargou a ocupação com o lote de 50, corrigido por lote de 10 no mesmo commit. Para o 2b-2. |
| DBG-57 | Média | pré-existente | `curationQueue.server.js:1407-1424` | Item apagado no admin é reposto pelo undo. Snapshot APPROVED volta sem marcador. PENDING perde `deletedInAdmin`. Vai para o 2b-2 junto com DBG-49. |
| DBG-58 | Média | pré-existente | `curationQueue.server.js:1424` | O undo substitui a metadata inteira pelo snapshot. Overrides, `lastPriceWrite`, `costAtPublish` e `deletedInAdmin` desaparecem. |
| DBG-59 | Média | pré-existente | `shopifyReset.server.js:237, 268`; `scripts/catalog/curation-revert-published.js:30` | O reset põe `targetStatus` em qualquer item com `shopifyProductId`, incluindo REJECTED por decisão humana. Um PUBLISHED rejeitado pode ser republicado. |
| DBG-60 | Baixa | diff | `curationQueue.server.js:1471` | `alertaPublicadoNaShopify` nunca sai, nem com nova aprovação e publicação, nem com reset. O undo fica bloqueado para sempre. |
| DBG-61 | Baixa | diff | `curationQueue.server.js:1468-1472`; `shopifyApprovedSync.server.js:353` | Se a regra recalcula o item durante a criação na Shopify, `markQueueItemPublished` grava só o alerta e não liga o item ao produto. O texto do painel fala de decisão humana, que não existe. |
| DBG-62 | Baixa | pré-existente | `structuredCatalogFilter.server.js:489` | `net > 0` deixa passar `netPrice` null. Premium com null e regra AUTO_APPROVE fica APPROVED. O publicador devolve SYNC_ERROR "Preço não calculado". |
| DBG-63 | Baixa | pré-existente | `shopifyApprovedSync.server.js:353` e catch | Falha em `markQueueItemPublished` depois de a Shopify criar o produto marca SYNC_ERROR sem `shopifyProductId`. O produto fica na loja sem ligação à fila. |
| DBG-64 | Baixa | diff | `api.trigger-sync.jsx:191`; `catalogRebuildStatus.server.js:54-61, 69-90`; `indexingStream.server.js:156-157` | Pausa nos primeiros ~5 s: a memória fica `paused`, mas só `running` é lido da memória. O gate lê `completed` do disco e publica. Correção proposta: gravar a paragem com `flushCatalogRebuildStatus`. |
| DBG-65 | Baixa | diff | `api.trigger-sync.jsx:191-195` | Mensagem "estado de indexação falhado" para paused, idle e running. O `return` salta também o sync de stock dos publicados (18b) e o catálogo de franquias. Consequência da Decisão 7. Aceite pelo arquiteto como está: stock atrasado é preferível a stock calculado sobre indexação incompleta. Nota para o 2b-3: aviso quando dois ciclos seguidos são recusados. |
| DBG-66 | Baixa | diff | `shopifyApprovedSync.server.js:338, 374`; `curationQueue.server.js:1453-1458` | A releitura é por SKU e lê o ficheiro inteiro. Cerca de 70 ms por leitura com fila de 15,7 MB. Custo de N aprovados × 70 ms. Correção: reler uma vez por lote. |
| DBG-67 | Baixa | diff | `indexingStream.server.js:232, 387, 400-403`; `atividadeApp.js:29` | Spawn falhado deixa o pid do principal no marcador de atividade. `atividadeAppEmCurso` fica verdadeiro até reiniciar a app. A reposição Shopify e os scripts de escrita recusam. Gatilho raro. |
| DBG-68 | Baixa | diff | `scripts/maintenance/logs-summary.mjs:96, 131-132` | `INDEX_ULTIMA_CAUSA` e `INDEX_ULTIMA_ESTADO` saem do texto bruto da linha, sem validação por categoria. Contra o contrato do cabeçalho. A app só escreve valores fixos. |
| DBG-69 | Média, se acontecer | pré-existente | `indexingStream.server.js:265-285`; `syncCatalogWithProgress.server.js:128-143, 364`; `shopifyApprovedSync.server.js:318-333` | Feed inválido (HTML com 200, cabeçalho trocado, linhas todas rejeitadas) termina `completed` com 0 linhas. O gate publica, e cada APPROVED passa a SYNC_ERROR por "SKU ausente". Corrigido no 2b-1: o gate exige `completed` com `totalRows > 0` (Decisão 7 do DBG-69). A recusa usa a marca "[ciclo] publicação recusada" com o motivo "indexação sem linhas". |
| DBG-70 | Baixa | pré-existente | `indexingStream.server.js:354-362, 149-163` | O listener de progresso continua ligado depois da paragem. Progresso tardio repõe `running` na memória e no disco, e a pausa perde-se. O gate fica seguro, porque a memória `running` recusa. |
| DBG-71 | Baixa | pré-existente | `api.shopify-sync.jsx:131, 202` | A publicação manual não passa pelo portão da Decisão 7 nem verifica indexação em curso. |

### Pendentes de `37bab0e`: decisões do arquiteto (16/10/2026)

- **D2 no reset (DBG-72).** Fica para o 2b-3. O reset continua proibido em produção até lá. Sem código neste PR.
- **Lista de scripts D7.** Bloqueia, e a verificação mostrou que os seis já chamavam `recusarSeAtividadeApp` no início de `main` ou no nível do módulo: `run-approved-sync.js:26`, `verify-post-ai-removal.js:25`, `catalog-purge-reindex.js:20`, `price-reconcile-apply.js:119`, `curation-spot-check.js:491` e `stream-import-dry-run.js:13`. Ao todo são 18 escritores com guarda, não 15. O teste `curation-atividade-app.test.js` passou a correr os 18 com um marcador vivo: código 1 e mensagem da guarda. M6 (tirar a guarda de `run-approved-sync.js`) deixa o teste vermelho. `stream-import-dry-run.js` grava a fila mesmo com `dryRun=true`: DBG-73, para o 2b-2.
- **D6 literal.** Aceita a leitura com regras. PENDING sem decisão humana continua governado por AUTO_APPROVE e AUTO_REJECT, e um item novo pode nascer APPROVED ou REJECTED pela regra. Sem código. O texto da Decisão 35 é corrigido no PR de documentação.
- **D5 de ponta a ponta.** Verificado e não confirmado. O checkpoint só avança depois do flush confirmado. O bloco citado (`indexingStream.server.js:277-287`) é o `finishDone`, que grava `checkpointScanned: null`, e não avança o checkpoint. O avanço só existe em `catalog-index-worker.mjs:65-71`, chamado por `confirmarJanelaDaFila` depois do `await flush` (`syncCatalogWithProgress.server.js:81-86`, com chamadas em `:201`, `:267` e `:292`). O progresso do principal não traz checkpoint (`indexingStream.server.js:113-114`, `:355`). Quando não há fila em memória, o checkpoint segue o lote, depois do insert na BD (`syncCatalogWithProgress.server.js:265-267`), e não há fila para confirmar. A recusa de flush com checkpoint parado já está coberta por `catalog-checkpoint-ordem.test.js`, caso C2. Sem código.
- **Purga de elite.** Fica no DBG-43, 2b-2. A purga continua proibida em produção. Sem código.
- **Custo no lock.** Log por lote no processo principal: `[fila] lote de N itens em X ms`, só com números. Medido na Fly depois do deploy.

### Dívida anterior ao 2b-1, para o PR 2b-2

Registada aqui para ficar no relatório. A causa, a linha, a correção, o teste e a mutação de cada item ficam no plano do 2b-2 (`docs/planos/plano-2b.md`), antes de qualquer código.

| ID | Estado | Descrição resumida |
|---|---|---|
| DBG-43 | 2b-2 | Purga de elite bloqueada até o 2b-2. Continua proibida em produção. |
| DBG-44 | 2b-2 | `approvedAt` e `rejectedAt` são repostos a null em reindex. |
| DBG-45 | 2b-2 | Assimetria entre reset e ciclo. |
| DBG-46 | 2b-2 | Fila justa entre processos e lock por lote no `upsertOne`. O arquiteto fixou o título "lock por lote no upsertOne e justiça do lock". |
| DBG-47 | 2c | Decisão 28 nas rotas: nenhuma sessão de leitura em paralelo com a publicação. |
| DBG-48 | 2b-2 | Flag `DB_DEGRADED` sem leitor. |
| DBG-49 | 2b-2 | Item apagado no admin sem origem própria. Vai junto com DBG-57. |
| DBG-50 | corrigido | Sync de catálogo punha ACTIVE por regra sem aprovação na fila. Corrigido em [#112](https://github.com/carlosrebelo14-ai/alterpop-importer2/pull/112), `727f44a`. |

### Achados do delta `220e6fc..3b6b6bf` (lente de concorrência, 16/10)

| ID | Sev | Origem | Local | Achado |
|---|---|---|---|---|
| DBG-74 | Média | pré-existente | `streamImport.js:155-171`, `:82-85`; `lib/importer/config.js:27` | O processamento do stream é serial. `trackTask` devolve a promessa quando `inFlight.size < maxInFlight`, e o ciclo faz `await` a cada registo. `pLimit` nunca passa de 1, e `STREAM_CONCURRENCY` e `SHOPIFY_GRAPHQL_CONCURRENCY` não têm efeito. Não afeta a correção, porque o lock não é mantido durante o processamento. |
| DBG-75 | Média | pré-existente | `ProductImporter.js:523`; `streamImport.js:150-152`; `curationQueue.server.js` (`upsertCurationQueueFromRecord`) | Cada registo é escrito duas vezes na fila: uma no lote, dentro de `comLockDaFila`, e outra em `processRecord`, com novo lock. Com lote de 10, são 11 aquisições de lock e 20 reescritas completas do ficheiro por lote, em vez de 1 e 10. É leitura de código, não medição. Liga-se a DBG-46. |
| DBG-76 | Baixa | delta | `streamImport.js:149-154` | O log `[fila] lote de N itens em X ms` mede desde antes de `comLockDaFila`. Soma a espera na fila em processo e a espera pelo lock de ficheiro, por isso X não é só o tempo de escrita. |
| DBG-77 | Baixa | delta | `scripts/tests/curation-atividade-app.test.js:180` e `:202-214` | O comentário diz "recusam … e sem gravar", mas o caso só verifica o código 1 e a palavra "Recusado". Não compara a fila em disco antes e depois. |

**Dívida baixa do diff** (lista para a descrição do PR #111): DBG-53, DBG-54, DBG-55, DBG-60, DBG-61, DBG-64, DBG-65, DBG-66, DBG-67 e DBG-68. O DBG-69 sai desta lista, corrigido no 2b-1.

**Numeração.** DBG-56 é usado: o blame mostrou que a espera em processo sem prazo é anterior ao diff. Os DBG-57 e DBG-49 vão para o 2b-2 juntos, porque ambos tratam de itens apagados no admin.

**Efeito colateral local.** Os probes da lente de integridade acrescentaram linhas a `logs/execution-history.log`, às 14:15 UTC. O ficheiro é ignorado pelo git, é local e não vai para produção. Fica como está, por decisão do arquiteto.


---
_Relatório produzido sem escrita em produção e sem alterações ao código da app._
