# Relatório de debug geral — alterpop-importer2

Data: 14/10/2026. Branch: `claude/ecstatic-galileo-v1agy7`. Base: `f377cb1`.
Modo: diagnóstico. Nenhuma correção aplicada. Nenhuma escrita em produção.

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
| DBG-04 | P1 | Fila de curadoria | Escritas perdidas entre processos. Aprovações feitas durante a indexação podem ser apagadas, e flushes do worker podem apagar aprovações. | O lock da fila (`curationQueue.server.js:71`) existe só em memória do processo. O worker é `fork` (`indexingStream.server.js:120`) e grava com `flushCurationQueueItems` (`syncCatalogWithProgress.server.js:182`). O processo principal faz read-modify-write com `saveCurationQueue` (`:244`). | Aprovar um SKU pela UI enquanto corre a indexação. Ver se o estado persiste depois do flush. | Um único escritor, ou lock entre processos (criação exclusiva de lockfile, ou o worker envia escritas por IPC ao processo principal). | Dois processos `fork` a alternar atualizações sobre a mesma fila. Nenhum item perdido. | Confirmado estrutural. Frequência por medir nos logs. |
| DBG-05 | P1 | Stock de publicados | Stock escrito na location errada quando as definições têm `locationId` diferente da location primária. | `api.trigger-sync.jsx:222` chama `syncPublishedStockLevels` sem `locationId`. A função usa env ou a location primária (`publishedStockSync.server.js:57`). O publisher usa `cfg.import.locationId` primeiro (`shopifyApprovedSync.server.js:197`). | Definir `locationId` nas definições com location não primária. Correr `trigger-sync`. Ver em que location muda o inventário. | Um helper único de resolução de location, usado pelo publisher e pelo sync de stock. | Com `locationId` nas definições, `syncPublishedStockLevels` escreve nessa location (cliente mock). | Confirmado no código. Impacto depende da definição em produção. |
| DBG-22 | P1 | Infra / curadoria | Fila de curadoria que não recupera reinicia com fila vazia, sem aviso. Um escritor grava essa fila por cima do ficheiro original. | `resetCorruptedQueueToEmpty` em `lib/curation/curationQueue.server.js`, chamado por `readAndCacheQueue` quando `recoverCorruptedQueueJson` devolve null. | JSON inválido sem caracteres de controlo em `curation-queue.json`. | Backup, flag `DB_DEGRADED` com a causa e leitura recusada. Painel abre com banner. Fila em falta: vazia só sem catálogo na BD. | `scripts/tests/curation-queue-guards.test.js`. | Em produção, SHA `58a99fe` (Lote 1, PR #104). Verificação pós-deploy na secção 10. |
| DBG-06 | P2 | Portão de saúde | O portão fica verde sem nenhum ciclo ter corrido. V13, V14, V15 e V17 passam com "sem estado". | `pre-pilot-verify.js:509, :542, :573, :635` usam `info()`, que tem nível `pass`. | Correr `catalog:health` sem estado de ciclo gravado. Ver `allPass`. | Sem estado após N horas, nível `warn` ou `fail`. | Portão com estado ausente não devolve verde. | Confirmado por leitura. |
| DBG-07 | P2 | Ingest CSV | Campo entre aspas com quebra de linha parte o registo. O produto perde custo, PVPR e stock, e aparece um SKU fantasma. | `streamCsv.js:109` lê linha a linha e não junta linhas de campo aspado. Probe: o produto A2 fica com `distributorPrice` null e stock 0. Surge o SKU `quebra de linha;5,00;7,00;2;SI`. | CSV sintético de 3 produtos, com quebra dentro de descrição aspada. Resultado: 4 registos e um SKU fantasma. | Parser com estado entre linhas. Contar registos contra linhas de dados e recusar o lote se não bater. | Fixture em `scripts/tests`: 3 registos e zero SKU fantasma. | Confirmado no parser. Frequência no feed real por medir. |
| DBG-08 | P2 | Ingest / indexação | A indexação grava linhas sem preço nem stock. O ciclo não compara o total com a corrida anterior. A deteção de queda só existe em V5, horas depois. | `syncCatalogWithProgress.server.js:218-225` não chama `validateRecord`. Esse validador só é usado em `core/streamImport.js:123`, o importador legado. | Linha sem `precio_distribuidores` no CSV. Resultado: entra no batch. | Rejeitar com motivo `sem_custo` via `recordCatalogRejection`. Check de queda de total antes do publish. | Linha sem custo gera `recordCatalogRejection` e não entra no batch. | Confirmado por leitura. |
| DBG-09 | P2 | Stock de publicados | Erro de leitura do catálogo vira "sem alteração" em todos os SKUs, sem falha contada. | `publishedStockSync.server.js:53` usa `fallback: []`. Os SKUs ficam em `skipped`. | Query que lança. Resultado: `skipped` = total e `failed` = 0. | `rethrow: true`, como no publisher (Tarefa 51). | Query que lança faz o ciclo devolver erro. | Confirmado por leitura. |
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

Lote 2, PR seguinte: DBG-04, DBG-05, DBG-06, DBG-09, DBG-15, DBG-16, DBG-21. Mais os achados novos da secção 9 (DBG-23 a DBG-32). Depois do lote 2, o portão passa a verificar os defeitos de forma automática, pelo método B18.

Regra até ao Lote 2: ninguém corre o reset da Shopify em produção enquanto o laço de apagamento não tiver teste (DBG-30).

## 9. Achados novos: Lote 2 e dívida

Origem: revisão adversarial do Lote 1 (dois ciclos, commits `98105b7` e `fc04a0a`..`ada684e`). Achados confirmados que não entraram no PR #104.

| ID | Sev | Lote | Origem | Achado | Teste previsto |
|---|---|---|---|---|---|
| DBG-23 | P1 | Lote 2 | Revisão Lote 1, ponto 3 | O restauro verifica só a BD. Com a fila corrompida, a flag volta na leitura seguinte. | `restore-db-degraded.js` recusa apagar a flag com a fila corrompida. |
| DBG-24 | P1 | Lote 2 | Revisão Lote 1, ponto 5 | `getDashboardStats` e `api.products.import-edits` engolem `DB_DEGRADED` e respondem 200. | Respondem 503 com a causa, com teste em modo degradado. |
| DBG-25 | P2 | Lote 2 | Revisão Lote 1, ponto 6 | `loadCurationQueueCached` devolve a cópia em memória sem olhar para a flag. | Com a flag ativa, a leitura em cache é recusada. |
| DBG-26 | P2 | Lote 2 | Revisão Lote 1, ponto 7 | `restore_dry_run` nunca exercita o ramo degradado, porque a cópia não tem flag. | A cópia em `/tmp` ganha flag sintética e o ramo corre. |
| DBG-27 | P2 | Lote 2 | Revisão Lote 1, ponto 8 | No CSV, a linha com aprovação recusada grava o override de título ou categoria. | A linha é atómica: aprovação recusada descarta o override da mesma linha. |
| DBG-28 | P2 | Lote 2 | Revisão Lote 1, ponto 9 | O painel fica com `decisions` desatualizado depois de recusa com `rejected` e depois de publicar. | O painel recarrega `decisions` após recusa e após publicação. |
| DBG-29 | P2 | Lote 2 | Revisão Lote 1, ponto 11 | O botão "Publicar Aprovados na Shopify" publica todos os APPROVED sem confirmação com a contagem. | Mantém o comportamento. Ganha confirmação com a contagem antes de publicar. |
| DBG-30 | P1 | Lote 2 | Revisão dos commits novos, achado 8 | O laço de apagamento de `runShopifyCatalogReset` não tem teste. A gravação das falhas só é coberta pelo sweep. | Teste do laço com cliente Shopify falso. Até lá, sem reset em produção. |
| DBG-31 | P2 | Lote 2 | Briefing do Lote 2 | A flag temporal do `flyctl logs` não está verificada. `logs_recent` vê só as últimas 100 linhas, não uma janela de tempo. | Verificar a flag `--since` no `flyctl` instalado e, se existir, usar uma janela na tarefa. |
| DBG-32 | P2 | Lote 2 | Briefing do Lote 2 | Os scripts de mutação Shopify não leem a flag. O `db:push` por CLI não tem guarda. | Os scripts recusam com a flag ativa. Guarda no `db:push`, com teste. |

Dívida (sem data de lote):

| ID | Sev | Lote | Origem | Achado | Teste previsto |
|---|---|---|---|---|---|
| DBG-33 | P3 | Dívida | Revisão Lote 1, ponto 10 | `scripts/sync/verify-post-ai-removal.js` imprime "Concluído" quando o pedido é recusado. | Imprime o resultado real e sai com código diferente de 0. |
| DBG-34 | P3 | Dívida | Revisão dos commits novos, achado 4 | `recentErrors` do reset guarda só 50 falhas. `failed` tem o total, mas a lista perde as restantes sem aviso. | Guardar todas, ou devolver o total com a lista truncada e um aviso. |
| DBG-35 | P3 | Dívida | Revisão do Lote 1 (`markDbDegraded`) | Se gravar a flag falhar depois do backup, cada leitura seguinte grava outro backup. | Falha ao gravar a flag lança com a causa, sem novo backup a cada leitura. |
| DBG-36 | P3 | Dívida | Revisão do Lote 1 (testes) | O caso de upsert não reproduz o título que voltava a APPROVED por regra AUTO_APPROVE. O assert cobre só PUBLISHED. | Caso com regra AUTO_APPROVE real, com `rules.json` no fixture. |

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

---
_Relatório produzido sem escrita em produção e sem alterações ao código da app._
