# Plano de implementação: PR 2b

Base: análise e verificação de leitura de DBG-04, DBG-21, DBG-23, DBG-25, DBG-26 e DBG-30, com as secções 8 e 9 de docs/relatorios/debug-geral-14-10-2026.md. Linhas citadas são as dos resultados. Nenhum ficheiro de código foi alterado. Nenhum comando git foi corrido. Nada foi executado. Os resultados "hoje passa" e "hoje falha" são previsões, não medições.

## 0. Legenda

- [CAUSA NÃO CONFIRMADA]: causa ou consequência sem prova por teste nem por execução.
- [FIX NÃO SEGURO]: a verificação deu fixSound false. Não implementar como está.
- [RELATÓRIO ERRADO]: afirmação do relatório que o código contradiz. Corrigir antes de o developer a usar.
- [DECISÃO Dn]: pede o arquiteto. Lista completa na secção 9.
- [ID EM CONFLITO]: ID proposto por mais de uma análise.

## 1. Estado por item

Nas seis causas raiz, a verificação deu rootCauseHolds true. O código confirma a causa. Nenhuma foi confirmada por teste.

| Item | Causa raiz | Fix proposto | Marcas |
|---|---|---|---|
| DBG-25 | Confirmada, elo a elo | Seguro (fixSound true), com condições | [CAUSA NÃO CONFIRMADA] cópia suja: dedução, sem teste. [RELATÓRIO ERRADO] linha :116. Texto do "ponto 6" não existe no checkout |
| DBG-04 | Confirmada: lock só de processo; worker grava cópia tirada no arranque | [FIX NÃO SEGURO] | [CAUSA NÃO CONFIRMADA] frequência; perda no sentido inverso; caso A não determinista. [RELATÓRIO ERRADO] linha :51 |
| DBG-21 | Confirmada nas causas 1 e 3. Causa 2 (duplicado na loja) não verificada | [FIX NÃO SEGURO] | [CAUSA NÃO CONFIRMADA] duplicado na loja; falso apagado (exige segunda falha). [RELATÓRIO ERRADO] linha :104, linha :57, "o reconciliador" |
| DBG-23 | Confirmada: a flag volta na leitura seguinte | [FIX NÃO SEGURO] | [RELATÓRIO ERRADO] coluna "Teste previsto", dry-run, pendentes do Lote 0. Texto "ponto 3" não existe no checkout |
| DBG-26 | Causa imediata confirmada. A causa de fundo (WAL com "|| true") é outro defeito | [FIX NÃO SEGURO] | [ID EM CONFLITO] DBG-37. [CAUSA NÃO CONFIRMADA] falso ok do WAL. [RELATÓRIO ERRADO] linha :117. Texto "ponto 7" não existe no checkout |
| DBG-30 | Confirmada por código | [FIX NÃO SEGURO] | [CAUSA NÃO CONFIRMADA] explicação de "ninguém testou"; previsões "hoje passa/falha"; R5. [RELATÓRIO ERRADO] linha :121. "Achado 8" não está no checkout |

Só o DBG-25 tem correção segura. Mesmo assim tem condições (passo 2.1).

## 2. Ordem por dependência

Regra geral: nenhum defeito entra sem teste que o apanha. Os testes da fase 1 são escritos antes de qualquer correção. Um teste de defeito que passa hoje está errado, ou o defeito não existe. Parar e rever.

### Fase 0: documentação (PR à parte, antes do código)

- 0.1 PR só de documentação com 41b4d66 sobre main. Resolver conflitos no relatório. Merge. Briefing, ponto 1. O commit e o pai (58a99fe) vêm do pedido. Não foram verificados aqui, porque o git está bloqueado.
- 0.2 Acrescentar ao relatório DBG-06, DBG-09 e DBG-15 parcial em produção no SHA 8960cf6. Briefing, ponto 2. Estes resultados não cobrem estes IDs.
- 0.3 Corrigir no relatório as afirmações da secção 6. Mínimo: linha :51 (DBG-04), secção 4 (DBG-21 sem linha), linha :57 (DBG-09), coluna "Teste previsto" de DBG-23, linhas :116, :117 e :121.
- 0.4 Resolver os IDs (secção 8). Até decisão, usar DBG-37, DBG-38 e, se for o caso, DBG-39. [DECISÃO D46]

Dependências: 0.1 antes de 0.2, 0.3 e 0.4.

### Fase 1: testes que apanham os defeitos

Nenhum código de produção muda nesta fase, exceto os pontos de injeção que a análise exige (ver secção 3). Ordem: 1.1 DBG-25, 1.2 DBG-30, 1.3 DBG-04, 1.4 DBG-23, 1.5 DBG-37, 1.6 DBG-26, 1.7 DBG-21. Ficheiros e casos na secção 3.

- 1.1 DBG-25: casos (a) a (d). Dependências: nenhuma. Os casos (a) a (c) devem falhar hoje. O caso (d) é contrato e deve passar.
- 1.2 DBG-30: harness do laço do reset, T1 a T8. Dependências: nenhuma. Exige stubs de Prisma (G2) e isolamento (G1). O ponto de injeção de D41 só entra se o arquiteto o pedir.
- 1.3 DBG-04: casos A a D, teste de origem test:sync-safety e caso em lote com SYNC_ERROR. Dependências: nenhuma. O caso C exige ponto de injeção em saveCurationQueue (alteração mínima de produção).
- 1.4 DBG-23: casos novos em restore-db-degraded.test.js. Dependências: nenhuma.
- 1.5 DBG-37: casos de WAL em maintenance.test.js. Dependências: 0.4 (ID) e fake sftp novo.
- 1.6 DBG-26: casos de restore_dry_run com flag sintética. Dependências: 1.5 (o fake sftp é partilhado) e decisão D29 sobre o ponto de injeção do ramo que não corre.
- 1.7 DBG-21: casos das partes A e B e da varredura. Dependências: D11 para o ciclo de deleted-never-approved.test.js.

### Fase 2: correções

Ordem por dependência. Os passos 2.1 e 2.2 não dependem um do outro. Os passos 2.7 e 2.8 são a parte do DBG-30 que não escreve na fila e a parte que escreve.

**2.1 DBG-25: cache invalidada depois de escrita falhada** (seguro, com condições)
- Dependências: 1.1. É a base de 2.6.
- Mudança: envolver o corpo de saveCurationQueue (curationQueue.server.js:331-348) em try/finally. Chamar invalidateCurationMemoryCache() no finally. A linha :346 deixa de ser necessária como passo separado.
- A guarda assertDbNotDegraded (:333) fica dentro do try. Se ficar antes, a recusa não chega ao finally.
- Condição (a): visibilityGatekeeper.js:110-128 guarda a referência ao objeto sujo durante até 2 s (QUEUE_CACHE_MS, linha :114). Limpar também essa cache, ou registar o resíduo no resumo.
- Condição (b): a importação live também lê a cópia suja (ProductImporter.js:173-178; visibilityGatekeeper.js:142-148). O alcance é maior do que listApprovedSkusForShopifySync (curationQueue.server.js:1243). A análise não o referia.
- Condição (c): com a correção, corrupção com flag presente passa a recusar a leitura (curationQueue.server.js:241). O painel mostra blocked e a página do catálogo falha (catalogProductsDb.server.js:862). Isto muda a política de leitura em modo degradado. [DECISÃO D34]
- Custo: depois de cada escrita falhada, uma leitura a frio de cerca de 15 MB. Vigiar memória (R18).
- Não implementar o teste opcional de falha na escrita. O nome do ficheiro tmp usa randomUUID() (curationQueue.server.js:340), e não há forma de o ocupar sem mock.
- Mutação: retirar o finally. Os casos (a) e (c) de 1.1 têm de ficar vermelhos.
- Ficar fora deste passo: resíduo de upsertCurationQueueBatchFromRecords com saveFile false (curationQueue.server.js:591-678). Ver 2.6.

**2.2 DBG-21 parte A: erro de leitura não vira "não existe" nem criação de produto** (independente de DBG-04)
- Dependências: D16 (severidade e ID do publicador). Verificar na loja se já houve duplicados. Não foi feito. Se houve, é ação à parte.
- resolveSku.js:69-74: deixar de engolir erros. Devolver null só com resposta bem-sucedida e sem nó. Não guardar null na cache. [CAUSA NÃO CONFIRMADA] para o duplicado na loja.
- Rever os cinco chamadores antes de mudar: InventoryImporter.js:55, ProductImporter.js:532, shopifyProductPublisher.server.js:184 e :322, publishedStockSync.server.js:90.
- shopifyProductPublisher.server.js:322-355: com erro de leitura, o item vai para SYNC_ERROR. Não há productCreate.
- ProductImporter.js:532-536: com allowCreate (linhas :129-131), corre createProduct. Não verificado se o método apanha o erro novo. Esta é a segunda instância da mesma causa.
- InventoryImporter.js:55-59: transforma uma falha de leitura em "SKU not found — run product import first". Viola a Decisão 30. Não estava na análise. Corrigir no mesmo passo.
- publishedStockSync.server.js:89-95: erro de leitura conta como falha com mensagem de leitura, não como "não encontrado". Hoje a mensagem passa por api.trigger-sync.jsx:238-242 e syncErrorLog.server.js:57-73.
- classifyRepriceRow (lib/importer/pricing/publishedReprice.js:99-103) e liveVariantsBySku.server.js:71-96: lista vazia não pode dar notFound sem prova por id.
- Mutação: reintroduzir o catch que devolve null (resolveSku.js:69-74). O teste de 1.7 tem de ficar vermelho.

**2.3 DBG-23: restauro que verifica também a fila** (não seguro como está)
- Dependências: D18 a D22 e D24 (secção 9); 1.4. É a base de 2.5.
- Extrair para lib/health/dbDegraded.js uma função pura, checkCurationQueueFile(file). Devolve { ok: true } ou { ok: false, cause }. Não escreve nada. Não usa Prisma. A regra de resolveCurationDataDir (curationQueue.server.js:30-40) passa a ser partilhada e não copiada.
- "ok" exige JSON válido e items como array. Hoje curationQueue.server.js:222-226 trata items em falta como fila vazia. Sem esta regra, o restauro limpa a flag sobre uma fila que a app lê como vazia. Viola a Decisão 30. Esta correção não estava na análise.
- scripts/setup/restore-db-degraded.js: chamar a função logo depois do integrity_check (linha :46). Se não der ok: imprimir o motivo, sair com 1 e manter a flag. Aplicar também ao dry-run (antes do retorno da linha :61).
- A saída "Nada a fazer" (linhas :48-51) também sai sem ver a fila. Decidir se a verificação corre sem flag. [DECISÃO D22]
- Não chamar loadCurationQueue() no script. A razão certa é que importa Prisma (app/db.server.js, linha :10) e aplica efeitos de recuperação. A razão dada na análise (lança antes de ler com flag presente) está errada. Ver secção 7.
- Fila sanitizável e fila em falta: recusar até decisão. [DECISÃO D19, D20]
- Regra do WAL: integrityRows (restore-db-degraded.js:24-26) abre a BD sem copiar o WAL (copySqliteSidecars, lib/health/dbDegraded.js:84-95). Corrigir no mesmo passo. Sem isto, a correção falha a regra do WAL.
- Decisão 28: restore-db-degraded.js:24 abre sessão Prisma própria, sem verificar publicação em curso. Decidir como o restauro se protege. [DECISÃO D22, D24]
- Dry-run de CI (scripts/ci/maintenance.sh:217-229) copia só dev.sqlite e dev.sqlite-wal e não define CURATION_DATA_DIR. Sem decisão sobre como a fila chega ao runner, a verificação vê outro ficheiro. [DECISÃO D24]
- Não mexer em fila nem em BD dentro do script.
- Testes: 1.4 e os unitários da função nova em scripts/tests/db-degraded.test.js. Este ficheiro já corre em test:deploy (package.json:80).
- Mutação: retirar a verificação do passo de fila. Os casos de fila corrompida e do dry-run têm de ficar vermelhos.

**2.4 DBG-37: "|| true" no sftp do WAL** (defeito próprio, não é DBG-26)
- Dependências: D30 (abrir como item próprio). Vem antes de 2.5.
- maintenance.sh:224: o sftp do WAL corre com "|| true". A falha é engolida. integrity_check corre sobre o ficheiro principal, sem as transações pendentes, e diz ok. Defeito em produção hoje (R15).
- Sondar a existência do WAL por ssh: WAL_PRESENT, WAL_ABSENT ou UNKNOWN, como flag_state (linhas :96-104). PRESENT e cópia falhada: RC=1, causa "não consegui copiar o WAL: a cópia não reflete a BD", sem integrity_check ok. ABSENT: segue. UNKNOWN: RC=2.
- Tirar o "|| true".
- Limite: as duas cópias sftp não são atómicas. Um checkpoint entre elas dá integrity ok sobre instantâneo que não é a BD. A sondagem não fecha esta corrida. Registar no resumo. [DECISÃO D26]
- Fake sftp (scripts/tests/maintenance.test.js:95-100): hoje o WAL falha sempre (linha :97). Mudar para aceitar FAKE_WAL=present|absent e FAKE_WAL_FAIL. Sem isto, os testes de 448-454 ficam vermelhos.
- Testes: 1.5.

**2.5 DBG-26: flag sintética na cópia de restore_dry_run**
- Dependências: 2.3 (comportamento final do restauro), 2.4 (WAL), D24, D25, D26, D27, D28, D29.
- scripts/ci/maintenance.sh, tarefa restore_dry_run (linhas :217-229): entre :224 e :225, escrever a flag sintética só em COPY_DIR. A pasta é mktemp -d (linha :219), não /tmp.
- Corrigir o formato do printf. A linha proposta tem uma barra invertida a mais antes do n. Grava caracteres literais, e JSON.parse (lib/health/dbDegraded.js:54-58) falha. A causa passa a "flag corrompida". Assertar o texto "sintética" na causa no teste.
- Depois do node (linha :225): se RESTORE_OUT tiver "Modo degradado ativo", o resumo acrescenta "ramo degradado: exercitado". Se não tiver, RC=1 com causa "o ramo degradado não correu". Fail-closed.
- O sinal "ramo degradado: exercitado" só sai com WAL confirmado (2.4). Sem isto, o sinal aparece com falso ok.
- Não tocar em /app/data/DB_DEGRADED. Não alterar scripts/setup/restore-db-degraded.js por este item. A alteração vem de 2.3.
- Ler o estado real da flag do volume, só para mostrar o estado: ausente, presente ou ilegível. ssh só de leitura. UNKNOWN com RC=2. Nunca "Nada a fazer" com 0. [DECISÃO D25]
- Ramo que não corre (teste de 1.6): não existe variável que remova a linha "Modo degradado ativo". O teste só se escreve com ponto de injeção. [DECISÃO D29]
- Mutação: apagar a linha do printf. O teste de ramo exercitado tem de ficar vermelho.

**2.6 DBG-04: escritor único** (passo mais pesado; ver riscos R1 a R7)
- Dependências: 2.1, D1 a D8. D5 e D6 são sugeridos pela verificação.
- (a) Proteger SYNC_ERROR no caminho em lote. A fusão de curationQueue.server.js:642-646 protege APPROVED, REJECTED, PUBLISHED e deletedInAdmin, mas não SYNC_ERROR. A linha :644 é o caminho que o worker usa. A Decisão 29 (docs/decisoes.md:130) exige proteção incondicional. A linha :656 aparece na análise de DBG-21 como protegendo SYNC_ERROR. Não verificado. Fazer antes de (c). Teste: caso em lote de 1.3.
- (b) O worker deixa de escrever no ficheiro. Envia por IPC ao processo principal o resultado por SKU: estado, shopifyStatus, motivo e metadados calculados. Substitui flushCurationQueueItems (syncCatalogWithProgress.server.js:182; curationQueue.server.js:358-372).
- (c) O processo principal aplica o lote dentro de withCurationQueueLock. Ao aplicar, lê o item atual do disco. Se tem decisão humana (APPROVED, REJECTED, PUBLISHED, deletedInAdmin e SYNC_ERROR pela alínea a), mantém status, shopifyStatus, overrides e lastPriceWrite do disco. Só atualiza título e metadados de origem. Regra igual a curationQueue.server.js:642-646, mais SYNC_ERROR, aplicada a cópia fresca. [DECISÃO D2, D6]
- (d) As regras ficam no worker: primeMarketSettingsForShop, setActiveMarketShop (syncCatalogWithProgress.server.js:108-109) e clearExcludeListCache. Só a escrita vai para o principal.
- (e) Checkpoint: o worker avança o checkpoint só depois de o principal confirmar o lote (syncCatalogWithProgress.server.js:246; lib/workers/catalog-index-worker.mjs:61-68). Sem isto, a retoma salta linhas. [DECISÃO D5]
- (f) Os *Locked passam a trabalhar sobre cópia, e substituem a cache só depois de save com sucesso (ver 2.1): approveProductLocked (:717-749), rejectProductLocked (:769-799), bulkSetQueueStatusLocked (:811-860), bulkSetMarginPctLocked (:946-963) e setManualOverrideLocked (:989-1031).
- (g) Escritores sem lock que passam pelo mesmo lock:
  - revertAllPublishedInQueue (shopifyReset.server.js:226-273; load :230; save :269). Ver D11 e D44 para SYNC_ERROR.
  - revertLocalAfterShopifyReset (:281-305; load :282; save :301).
  - syncCurationQueueAfterElitePurge (eliteCuration.server.js:179-210; save :210).
  - upsertCurationQueueBatchFromRecords com saveFile true (curationQueue.server.js:591-675; save :674-675; chamadores catalogProductsDb.server.js:122 e :131).
  - recoverCorruptedQueueJson (curationQueue.server.js:262): save sem lock. Omitido na análise. Encontrado na verificação.
  - Retoma: refreshCatalogIndex (syncCatalogWithProgress.server.js:273-278; catalogIndex.server.js:79; catalogProducts.server.js:120; catalogProductsDb.server.js:108-133).
- (h) Não resolve Decisão 28 nas purgas e nos resets: deleteMany em lote (eliteCuration.server.js:134-143), runShopifyCatalogReset (shopifyReset.server.js:359) e reinserção do catálogo (catalogProductsDb.server.js:95-100 e :121). [DECISÃO D3]
- (i) Não usar lockfile sem decisão. Após SIGKILL ou OOM do worker, o handler de exit não corre e o lock fica órfão. [DECISÃO D1]
- (j) Não confiar na cache entre processos. loadCurationQueue compara só mtimeMs (curationQueue.server.js:90). Dois escritores com o mesmo mtime deixam um processo com cópia antiga. Improvável em ext4. Não garantido no volume da Fly. Não verificado.
- (k) Custo: lotes de até 5000 itens ao principal por IPC. O número de "cerca de 250 ms com 29.601 itens" (comentário de curationQueue.server.js:341-343) foi medido com indent:2. O save atual não usa indentação. Não aplicar esse número. Medir de novo. [CUSTO NÃO MEDIDO]
- (l) Interino, se o arquiteto pedir: bloquear aprovações e rejeições na UI enquanto isCatalogIndexingRunning for verdadeiro. A rota api.curation.queue.$sku.approve.jsx:24 não consulta. Custo operacional para o Carlos. [DECISÃO D4]
- Testes: 1.3 (casos A a D, test:sync-safety, caso em lote com SYNC_ERROR).
- Mutações: (a) tirar o lock de approveProductLocked: A e C vermelhos. (b) repor escrita cega do flush, sem fusão contra o disco: B e D vermelhos. (c) worker a escrever diretamente no ficheiro: A vermelho.
- Não dar DBG-04 como fechado só com testes. A frequência continua por medir (R1).

**2.7 DBG-30, correções 2 a 4** (não escrevem na fila; independentes de DBG-04)
- Dependências: 1.2.
- (2) Registo no aborto. A falha do produto que aborta entra em recentErrors antes do throw (shopifyReset.server.js:430-446). failShopifyResetJob (shopifyResetJob.server.js:133-140) passa a aceitar um patch com recentErrors.slice(-50) e os contadores atuais. Hoje grava só state, error, currentTitle e finishedAt.
- (3) Aviso de auth. ShopifyClient lança Error simples em HTTP não-2xx (shopifyClient.js:65), nunca ShopifyAuthSessionError. O catch externo (shopifyReset.server.js:494-499) regrava o estado com a mensagem crua. Marcar falhaRegistada = true antes do failShopifyResetJob interno, e no catch externo não regravar quando a marca estiver ativa. Os classificadores (loadOfflineSessionForShop.server.js:180-190) também apanham "401" de um Error simples.
- (4) Listagem. Lançar erro se faltar data.products ou pageInfo (shopifyReset.server.js:112-134; linhas :118 e :131-132). Nunca tratar a ausência como fim de lista. Lista parcial hoje apaga em silêncio.
- Testes: T2, T2b, T3, T5, e T8 como baseline.
- Mutações: M1 (remover falhas.ids.add), M2 (remover recentErrors.push), M3 (trocar continue por throw), M4 (remover o ramo isShopifyAuthError).

**2.8 DBG-30, correções 5 a 7** (escrevem na fila)
- Dependências: 2.6, 2.7, D35 a D44.
- (5) Loja vazia. Não sair antes da varredura (shopifyReset.server.js:389-397). O comentário das linhas :335-337 diz que a varredura corre. Confirmar a regra antes de mudar. [DECISÃO D37] Conclusão só com segunda leitura: countShopifyProductsForReset (:95-100). Se as duas leituras não baterem, recusar. Não concluir "todos apagados" a partir de uma listagem vazia (Decisão 30).
- (5b) SYNC_ERROR. revertAllPublishedInQueue põe SYNC_ERROR em PENDING (:235 e :243-248). A Decisão 29 só admite três transições manuais. Decidir se este caminho sai. [DECISÃO D44]
- (6) Gravação local. Parar o run na primeira falha de gravação local depois de um apagamento. [DECISÃO D35] Ler readDbDegraded() antes de cada productDelete, como a rota (api.shopify-reset.jsx:80-87). [DECISÃO D36] Hoje o catch (:456-461) só regista e segue. Teste T6. Mutação M5 (deleted += 1 movido para depois da gravação local).
- (7) Varredura por pid. Se o item tem pid, decidir só pelo pid, como revertLocalAfterShopifyReset (:290). Hoje shopifyReset.server.js:239 aplica exceção por SKU mesmo com pid próprio. Teste T7 (unitário): item S-1 com pid 30; revertAllPublishedInQueue({ deletedInAdmin: true, exceptSkus: ['S-1'], exceptIds: ['gid://shopify/Product/31'] }) devolve 1 e o item fica PENDING. Hoje devolve 0.
- Limite de falhas seguidas e comportamento. [DECISÃO D38] Trinco órfão. [DECISÃO D39] Gravação por produto ou por lote de 20. [DECISÃO D40]
- Ciclo agendado: api.trigger-sync.jsx:117-123 e :210 não consultam reset em curso. api.shopify-sync.jsx:121 consulta. [DECISÃO D42, D43]
- Purga de linha de comandos: scripts/catalog/shopify-products-purge.js:57 chama runShopifyCatalogReset sem ler DB_DEGRADED. Acrescentar a guarda. Corrigir o cabeçalho (linhas :11-12): diz que a fila volta a APPROVED. O código põe PENDING com deletedInAdmin.
- Testes: T4, T6, T7. Mutações M5 e as de 2.7 continuam a valer.

**2.9 DBG-21 parte B: estados da fila** (depende de DBG-04)
- Dependências: 2.6, D10 a D12, D11 (Decisão 29).
- markQueueItemDeletedInAdmin (curationQueue.server.js:1176-1187): hoje aceita qualquer estado de origem e limpa syncError. Aceitar só PUBLISHED como origem. A decisão sobre SYNC_ERROR e REJECTED está em D11.
- Migração: lib/curation/deletedMigration.js:12 inclui SYNC_ERROR em MIGRATABLE_FROM. A mesma função é chamada por scripts/catalog/curation-mark-deleted.js:102. Dar entrada separada à migração. Sem separação, a guarda não se aplica. [FIX NÃO SEGURO sem isto]
- Saídas de SYNC_ERROR fora do fix, que a Decisão 29 proíbe: shopifyReset.server.js:245-250 (SYNC_ERROR para PENDING, syncError a null); :292-296 (applyDeletedInAdmin); :227 (APPROVED por omissão no revert); scripts/catalog/curation-revert-published.js:28 e :63 (--to APPROVED). Decidir antes do merge. [DECISÃO D11]
- applyDeletedInAdmin (curationQueue.server.js:1196-1214) não tem guarda de estado e põe PENDING. Está correto por si. Depende da entrada.
- bulkTransitionPending (curationQueue.server.js:881-915) põe APPROVED em qualquer PENDING elegível, incluindo itens apagados. approvalGuard.js:30-34 só bloqueia PUBLISHED. [DECISÃO D12]
- scripts/tests/deleted-never-approved.test.js:41: o ciclo afirma sucesso para SYNC_ERROR e REJECTED. Tem de mudar, não só ganhar um caso novo. Os casos 80-86 e 127-137 fixam a aprovação em massa de apagados como intencional. Mudar só se D12 disser.
- Marca de deletedInAdmin: uma aprovação nova limpa a marca ou não? Hoje nada a limpa. [DECISÃO D10]
- Mutação: reintroduzir SYNC_ERROR como origem válida. O teste de recusa tem de ficar vermelho.

**2.10 DBG-21 varredura do reset (fix 5)**
- Dependências: 2.8 (passos 5 e 6), 2.9, D13.
- shopifyReset.server.js:469-475: antes do sweep final, confirmar com product(id) cada PUBLISHED que não ficou na listagem. Abortar se a listagem não tiver pageInfo válido.
- Hoje shopifyReset.server.js:241-244 aplica applyDeletedInAdmin a qualquer PUBLISHED, com ou sem shopifyProductId, a partir de uma só leitura de listagem. Viola a Decisão 30. [DECISÃO D13]
- Sem confirmação por product(id), não marcar.
- Teste: 1.7 (listagem sem pageInfo, curation-queue-guards.test.js:150-195).

**2.11 DBG-21 reconciliador** (só se D9 pedir ciclo automático)
- Dependências: 2.9, 2.6, D9, D14, D17.
- Guarda da Decisão 28: verificar isShopifySyncRunning, como executeReprice (publishedReprice.server.js:205-208). Hoje nada impede corrida com runApprovedShopifySync.
- Reusar a prova de publishedReprice: product(id) === null, um a um (publishedReprice.server.js:132-144 e :243-254). Só PUBLISHED com shopifyProductId. Abortar se mais de 5 % dos publicados ficarem sem produto (Decisão 34, ponto 8). Nunca concluir a partir de lista vazia.
- Base possível: marginErosion.server.js:192-194 já corre fetchLiveVariantsBySku e diagnoseMissingLive em cada ciclo (api.trigger-sync.jsx:269). Não escreve na fila. Não estava na análise.
- Teste: caso do reconciliador em 1.7, se D9 pedir o ciclo.

**2.12 Execuções em produção** (manual, depois de OK do arquiteto)
- curation-mark-deleted.js --execute (linhas :58-84). Com id guardado, há segunda leitura por product(id). Sem id, a prova é só a pesquisa de variantes, que pode falhar por atraso do índice (:69; deletedMigration.js:40).
- curation-requeue-deleted.js:87-116 e :146 também usam prova. Não estava na análise.
- "Aplicar aos publicados" (publishedReprice.server.js:243-254).
- shopify-products-purge.js --execute: ver 2.8.
- Não correr durante corrida de publicação (Decisão 28). Exige OK do arquiteto (Decisão 33, ponto 3) e registo em docs/execucoes.md (Decisão 34, ponto 10). [DECISÃO D45]

### Fase 3: mutação e revisão adversarial

- Cada item: as mutações da secção 3 correm uma a uma. Cada mutação tem de fazer o teste correspondente falhar. Uma correção só é válida quando a mutação volta a derrubar o teste.
- Revisão adversarial: segunda leitura de cada correção contra as Decisões 28, 29, 30, a regra do WAL e o modo degradado. As verificações desta análise servem de lista de verificação.

### Fase 4: fecho

- Merge do PR 2b. Depois disparar deploy.yml e parar (briefing, ponto 5).
- Depois do deploy: db_flag_check, catalog_health e logs_recent (nota do Carlos). Carlos aprova em Review deployments.

## 3. Testes a criar

Condição: um teste de defeito que passa hoje está errado, ou o defeito não existe. Parar e rever.

| Item | Ficheiro | Estado | Casos | Mutação que tem de o derrubar |
|---|---|---|---|---|
| DBG-30 | scripts/tests/shopify-reset-loop.test.js (novo; script test:* próprio no package.json; ligado ao CI) | novo | T1: 3 apagados, sem falhas (baseline, passa). T2: userError não-auth no produto 2, com SKU (falha hoje, registo). T2b: igual, sem SKU (passa hoje). T3: produto 2 responde 401, corpo JSON (falha hoje em error e recentErrors). T4: loja sem produtos com PUBLISHED (falha hoje). T5: segunda página sem products (falha hoje; zero productDelete). T6: flag gravada no primeiro productDelete (esperado depois de D35). T8: paginação em duas páginas (baseline) | M1 remover falhas.ids.add (T2b); M2 remover recentErrors.push (T2); M3 trocar continue por throw (T2); M4 remover o ramo isShopifyAuthError (T3); M5 deleted += 1 depois da gravação local (T6) |
| DBG-30 | scripts/tests/curation-queue-guards.test.js (T7, ou ficheiro novo) | novo caso | T7 unitário (ver 2.8) | Reintroduzir a exceção por SKU (:239) |
| DBG-30 | scripts/tests/curation-queue-guards.test.js:147-168 | existente, insuficiente | Sweep com listas à mão. Não gera falhas. Não cobre a gravação do laço | Nenhuma: não apanha nada do laço |
| DBG-25 | scripts/tests/curation-queue-guards.test.js, bloco :102-109 | alterar | (a) approveProduct('P3') recusado; ler sem invalidar; P3 continua PENDING em loadCurationQueue, loadCurationQueueCached e loadCurationQueueForPanel. Hoje falha, porque clearFlag() (:108) esconde o estado sujo. (b) bulkSetMarginPct(['P3'], 20) recusado; cache sem marginPct em P3. Hoje falha. (c) restauro: approveProduct('P3') recusado; remover o ficheiro da flag sem invalidar; approveProduct('P4'); P3 continua PENDING no ficheiro. Hoje falha. (d) contrato: flag presente, fila saudável; loadCurationQueueCached devolve sem recusar; loadCurationQueueForPanel devolve blocked null. Passa hoje | Retirar o finally de saveCurationQueue: (a) e (c) vermelhos |
| DBG-25 | scripts/tests/publisher-price-policy.test.js:293-306 | manter verde | Contrato de leitura (Decisão 34) | Nenhuma: é guarda contra regressão |
| DBG-04 | scripts/tests/curation-queue-cross-process.test.js (novo) | novo | A: dois forks; 200 PENDING; fork 1 aprova 100 SKUs com pausas; fork 2 faz flush de 100 novos; espera 300 entradas, 100 APPROVED e 100 novos. Hoje falha. É probabilístico: repetir ou injetar atraso. B: pai carrega S em PENDING; fork aprova S; pai faz flush com a cópia; espera APPROVED. Variante: S REJECTED em disco e AUTO_APPROVE na cópia; espera REJECTED. Hoje falha. C: upsertCurationQueueBatchFromRecords(lote, {}) concorrente com approveProduct, com atraso injetado em saveCurationQueue. Exige ponto de injeção. Hoje falha. D: fork faz setManualOverride ou bulkSetMarginPct enquanto o pai faz flush de overrides antigos; espera o override mais recente (:654-655). Hoje falha | (a) tirar o lock de approveProductLocked: A e C; (b) repor escrita cega do flush: B e D; (c) worker a escrever direto: A |
| DBG-04 | test:sync-safety (package.json); ficheiro a definir no estilo de scripts/tests/deleted-never-approved.test.js:133 | novo | Nenhum caminho fora do escritor único chama saveCurationQueue nem faz load-save sobre a fila. Inclui recoverCorruptedQueueJson (:262) | Chamar saveCurationQueue fora do escritor |
| DBG-04 | Caso em lote com SYNC_ERROR: ficheiro novo, ou scripts/tests/curation-sync-error-protection.test.js (hoje só importa upsertCurationQueueFromRecord, linha 42) | novo caso | upsertCurationQueueBatchFromRecords sobre SYNC_ERROR não muda o estado. Hoje falha | Retirar SYNC_ERROR da proteção do lote |
| DBG-23 | scripts/tests/restore-db-degraded.test.js | alterar | (a) BD íntegra, flag presente, CURATION_DATA_DIR com "{ isto não é json", --execute --ref RESTORE-1: status 1, flag presente, "fila" no stderr. Hoje sai com 0 e apaga a flag. (b) Mesma fila sem --execute: status 1, flag presente. Hoje sai com 0. (c) Fila em falta: status 1, flag presente (regra de D20). (d) Caso de :122-130 com CURATION_DATA_DIR explícito e fila válida: status 0, flag removida. Hoje já passa, mas sem isolar a fila lê server/data do repositório. (e) Bytes da fila iguais depois do script; nenhum curation-queue.json.corrupt-* novo | Retirar a verificação do passo de fila: (a) e (b) vermelhos |
| DBG-23 | scripts/tests/db-degraded.test.js (unitários de checkCurationQueueFile, depois de 2.3) | alterar | Ficheiro ausente; JSON inválido; JSON válido sem items como array (Decisão 30); JSON válido com items. Assertar { ok, cause } e que não cria nem altera ficheiros | Trocar a regra do items por fila vazia: o caso sem array tem de ficar vermelho |
| DBG-37 | scripts/tests/maintenance.test.js (bloco restore_dry_run, :448-466, e fake sftp :95-100) | alterar | (a) WAL presente e cópia do WAL falha: status 1, "WAL" no resumo, sem "integrity_check da cópia: ok". Hoje sai com ok. (b) WAL ausente: segue, status 0. (c) Ordem no FAKE_LOG: dev.sqlite antes do WAL (opcional) | Repor o "|| true" em maintenance.sh:224: (a) vermelho |
| DBG-26 | scripts/tests/maintenance.test.js (:448-466) | alterar | (a) Cópia íntegra com flag sintética: status 0, "ramo degradado: exercitado" no resumo, nenhuma chamada ssh sobre a flag do volume, sem --execute. (b) Cópia corrompida com flag sintética: status 1, "não passa integrity_check", "ramo degradado: exercitado". (c) Ramo que não corre: status 1, causa "o ramo degradado não correu". Exige ponto de injeção (D29). Não implementável como descrito | Apagar a linha do printf: (a) vermelho. Trocar a causa por texto sem "sintética": (a) vermelho |
| DBG-26 | scripts/tests/restore-db-degraded.test.js:88-98 e :100-130 | manter | Já exercitam o ramo com flag em pasta temporária | Nenhuma |
| DBG-21 | scripts/tests/resolve-sku-read-failure.test.js (exemplo de nome) | novo | Cliente que lança em client.graphql: resolveVariantBySku lança, não devolve null; a cache não guarda null | Reintroduzir o catch que devolve null (resolveSku.js:69-74) |
| DBG-21 | scripts/tests/publisher-existence-read.test.js (exemplo de nome) | novo | SKU APPROVED; leitura de existência lança: zero productCreate; item em SYNC_ERROR | Repor o ramo que cria produto com existing null |
| DBG-21 | scripts/tests/stock-sync-failure-log.test.js | alterar | Cliente que lança em resolveVariantBySku: result.failures sem "não encontrado"; failed conta a falha com mensagem de leitura | Repor a mensagem "não encontrado" (publishedStockSync.server.js:89-95) |
| DBG-21 | scripts/tests/published-reprice.test.js | alterar | buildRepricePreview com fetchLive a devolver Map vazio e product(id) a lançar: zero linhas notFound; categoria failed | Repor o null como notFound (publishedReprice.js:99-103) |
| DBG-21 | scripts/tests/deleted-never-approved.test.js:41 (ciclo), :80-86, :127-137 | alterar | markQueueItemDeletedInAdmin sobre SYNC_ERROR é recusado e syncError fica intacto. O ciclo atual afirma sucesso para SYNC_ERROR e REJECTED; tem de mudar | Reintroduzir SYNC_ERROR como origem válida |
| DBG-21 | scripts/tests/curation-queue-guards.test.js:150-195 | alterar | Listagem sem pageInfo ou truncada: o sweep não aplica deletedInAdmin | Retirar a verificação de pageInfo (shopifyReset.server.js:469-475) |
| DBG-21 | Caso do reconciliador (só se D9) | novo | PUBLISHED com id e product(id) null: marcado. Com erro de leitura: intacto. Map vazio com produto existente: failed. SYNC_ERROR, PENDING e PUBLISHED sem id: intactos | Retirar a guarda de isShopifySyncRunning |

Testes que não se implementam como descritos:
- DBG-25: falha de escrita fora do modo degradado (nome tmp com randomUUID, curationQueue.server.js:340).
- DBG-26: ramo que não corre (falta ponto de injeção; D29).
- DBG-04 caso C: exige ponto de injeção em saveCurationQueue. Se o arquiteto não aceitar, o teste fica probabilístico. Registar isso.

## 4. Guardas exigidas

- G1 Isolamento. CURATION_DATA_DIR, DATABASE_URL e PROJECT_ROOT apontam a diretório temporário antes de qualquer import. scripts/tests/_isolate-curation.js é o primeiro import (linhas :7-15). Nunca /app/data. Para DBG-30: SHOPIFY_SHOP_URL e SHOPIFY_ACCESS_TOKEN da loja de teste, SESSION_STORAGE=file (lib/session/resolveSessionStorage.js:15), SHOPIFY_GRAPHQL_MIN_MS=0 (lib/importer/config.js:28), e chdir para o temporário, porque RESULTS_ERRORS_PATH usa cwd.
- G2 Decisão 28. Os testes não abrem sessão Prisma real. Stub de deactivateAllSyncErrors (shopifyReset.server.js:480) e de safePrisma (lib/prisma/prismaSafe.server.js:30-59). Sem stub, o teste escreve na BD temporária sem esquema.
- G3 Decisão 29. SYNC_ERROR protegido em todos os caminhos de escrita da fila, incluindo o em lote.
- G4 Decisão 30. Falha de leitura nunca vira conclusão. Concretamente: resolveSku propaga erro; listagem Shopify sem products ou pageInfo lança; "ok" do restauro exige items como array; falha de cópia do WAL não é ok; fila em falta não se grava como vazia (curationQueue.server.js:134-159).
- G5 Regra do WAL. Código que abre SQLite copia o WAL antes de abrir. Hoje falha em restore-db-degraded.js:24-26 (corrigir em 2.3) e em maintenance.sh:224-225 (corrigir em 2.4).
- G6 Modo degradado. Não acrescentar verificação de flag à leitura em cache (Decisão 34: leituras passam). Não tirar guardas de escrita existentes.
- G7 Produção. Nenhuma escrita de produção sem OK (Decisão 33, ponto 3). Registo em docs/execucoes.md (Decisão 34, ponto 10). Nada disto corre durante corrida de publicação (Decisão 28).
- G8 Mutação. Cada correção é válida só quando a mutação correspondente volta a derrubar o teste.

## 5. Riscos em produção

- R1 (DBG-04). Aprovações e rejeições feitas durante a indexação podem reverter em silêncio. Uma rejeição pode voltar a APPROVED pelas regras automáticas e ser publicada. Por leitura, a probabilidade é alta. Não medida. Medir: cruzar approvedAt e rejectedAt com as linhas [indexacao] de logs_recent.
- R2 (DBG-04, DBG-30). Reset e publicação agendada correm em paralelo. api.trigger-sync.jsx:117-123 e :210 não consultam reset. As escritas do reset sem lock (shopifyReset.server.js:226-301) podem apagar aprovações feitas durante o reset.
- R3 (DBG-04). Exposição na retoma. A análise diz que decisões humanas na janela entre flushes se perdem. Isto está errado: a retoma recarrega a fila do disco em cada lote (curationQueue.server.js:594), e saveCurationQueue invalida a cache (:346). A exposição real é SYNC_ERROR e os campos não protegidos.
- R4 (DBG-04). Memória. IPC leva lotes de até 5000 itens ao principal. Já houve OOM em 09/10 (curationQueue.server.js:93-95). O custo do save atual não está medido.
- R5 (DBG-04). Lockfile órfão após SIGKILL ou OOM do worker. Evitar (D1).
- R6 (DBG-04). Cache comparada só por mtimeMs (:90). Improvável, não garantido no volume da Fly.
- R7 (DBG-04). Escritores fora da app. scripts/catalog/curation-override-clear.js:70 escreve na fila a partir de outro processo. Não verificado nesta leitura. scripts/catalog/full-catalog-reindex.js não escreve na fila: skipSmartRules: true (linha :60), inMemoryQueue null (:144).
- R8 (DBG-21). Duplicado na loja. Uma leitura falhada durante a publicação de SKU já existente cria produto novo (shopifyProductPublisher.server.js:322-354; resolveSku.js:69-74). ProductImporter.js:532-536 tem o mesmo risco. Não verificado na loja. Sugerido P0 (D16).
- R9 (DBG-21). Falso apagado. curation-mark-deleted --execute sobre log com "não encontrado" vindo de leituras falhadas. Um produto vivo perde shopifyProductId (applyDeletedInAdmin). Com id, há segunda leitura. Sem id, só pesquisa de variantes, que pode falhar por atraso do índice. Só acontece se a pesquisa também falhar.
- R10 (DBG-21). Aprovação em massa reativa itens apagados (bulkTransitionPending). Quem aprovar "todos os PENDING" com filtro publica produtos que o Carlos apagou. Sem confirmação por item.
- R11 (DBG-21). Sweep com listagem truncada marca vivos como apagados sem prova por id, se pageInfo faltar. Probabilidade baixa e sem guarda.
- R12 (DBG-21). SYNC_ERROR sai da fila sem transição manual: markQueueItemDeletedInAdmin limpa syncError (D11).
- R13 (DBG-23). O restauro apaga a flag com fila corrompida. O dry-run sai com 0. Cada ciclo deixa backups de cerca de 15 MB (comentário de curationQueue.server.js:94), que se acumulam no volume.
- R14 (DBG-23, DBG-26). O dry-run de CI valida outro ficheiro: sem CURATION_DATA_DIR, o caminho cai em server/data, que o .gitignore exclui (linha :26). Ou recusa por ENOENT com causa errada, ou passa sem ver a fila.
- R15 (DBG-37). Falso ok em produção hoje. "|| true" (maintenance.sh:224) deixa integrity_check ok sobre o ficheiro principal, sem o WAL.
- R16 (DBG-26). Cópias sftp de BD viva não são atómicas. Resultado: falso falhou ou falso ok. Não há wait_for_indexing (db_push espera em :241). A Decisão 28 não é violada na letra, porque restore-db-degraded.js:24 abre Prisma só sobre a cópia. Herda a concorrência da app.
- R17 (DBG-25). Aprovação recusada (503) fica em memória e sai na próxima escrita bem-sucedida. Pode seguir para a Shopify por listApprovedSkusForShopifySync (:1243), ProductImporter.js:173-178 e visibilityGatekeeper.js:142-148. Resíduo de 2 s (visibilityGatekeeper.js:114). Hoje a flag está ausente (db_flag_check 38715913873) e não há recusas na janela de logs. Risco latente.
- R18 (DBG-25). A correção força leitura a frio (cerca de 15 MB) em cada escrita falhada. Em modo degradado, cliques repetidos geram uma leitura cada. O inflight de loadCurationQueue (:96-98) só junta leituras simultâneas. Vigiar memória.
- R19 (DBG-25). Corrupção com flag presente passa a recusar leituras (D34). O painel mostra blocked e a página do catálogo falha, só com fila corrompida.
- R20 (DBG-30). Shopify em baixo ou com throttling persistente. Cada chamada espera 1+2+4+8+16 s (shopifyClient.js:38-56). Com cerca de 5575 produtos a 31 s cada, são cerca de 48 h. O estado fica em deleting, que bloqueia a publicação manual (api.shopify-sync.jsx:121). Limite de falhas: D38.
- R21 (DBG-30). Purga de linha de comandos sem guarda da flag (shopify-products-purge.js:57). Produtos apagados na loja sem registo local. Recupera-se com nova execução, mas só com a BD de volta.
- R22 (DBG-30). Loja vazia: itens PUBLISHED sem produto continuam PUBLISHED, porque a varredura é saltada (:389-397). Caso PR6 em docs/PROJECT-TODO.md:214.
- R23 (DBG-30). Trinco órfão se o processo morrer: a escrita final nunca corre. O cabeçalho de scripts/catalog/reset-lock-release.js (linhas :3-5) descreve um trinco preso em deleting durante 15 dias, em 09/09. Essa execução não está provada. Bloqueia api.shopify-sync e a rota de reset, mas não api.trigger-sync.
- R24 (DBG-30). Desempenho. Cada produto apagado que está na fila faz leitura e reescrita completa (revertLocalAfterShopifyReset, :281-305). Milhares de reescritas numa loja grande.
- R25 (DBG-30). Corrida no estado de progresso: escrita de listagem sem await (:379-384) concorre com escritas aguardadas (shopifyResetJob.server.js:62-73). Impacto baixo.
- R26 (DBG-30). deactivateAllSyncErrors(shop).catch(() => {}) (:480) engole erros. O job diz completed.
- R27 (DBG-30). Documentação errada no cabeçalho de shopify-products-purge.js (linhas :11-12). Quem lê espera republicação.

## 6. Afirmações do relatório erradas

Corrigir antes de o developer usar o relatório. Linhas são de docs/relatorios/debug-geral-14-10-2026.md.

DBG-04 (linha :51)
- RE-01: "O lock da fila (curationQueue.server.js:71)". A linha :71 é comentário. O lock está em :74-82.
- RE-02: "O worker é fork (indexingStream.server.js:120)". A linha :120 é a condição de retoma. O fork está em :149.
- RE-03: "saveCurationQueue (:244)" como escrita do processo principal. A linha :244 é a sanitização do JSON. As escritas read-modify-write estão em :717-749, :769-799, :811-860, :946-963 e :989-1031.
- RE-04: "Um único escritor, ou lock entre processos" como correção mínima. Não chega. A cópia obsoleta do worker (syncCatalogWithProgress.server.js:144) é gravada por cima do disco (curationQueue.server.js:368-372).
- RE-05: descreve só um sentido da perda. Falta o sentido inverso: um save do principal reescreve o ficheiro com a cópia que leu antes e apaga o flush do worker.
- RE-06: o teste proposto de dois forks não cobre a cópia obsoleta nem os escritores sem lock.

DBG-21 (linhas :104 e :57)
- RE-07: DBG-21 não tem linha na secção 4. Só aparece na secção 8, linha :104.
- RE-08: "o reconciliador" é tratado como ciclo existente. Não existe ciclo automático. Só há ações manuais: publishedReprice.server.js:243-254 e scripts/catalog/curation-mark-deleted.js.
- RE-09: linha :57 (DBG-09) diz que publishedStockSync.server.js:53 usa fallback []. Está desatualizada. A leitura usa rethrow: true em publishedStockSync.server.js:37.
- RE-10: "a regra de 09/10 só está em comentários e cabeçalhos de testes" e "não está escrita em docs/decisoes.md". Incompleto. docs/decisoes.md refere a regra (linhas :264 e :227). O conteúdo é que não está escrito.

DBG-23 (linha :114)
- RE-11: a coluna "Teste previsto" é lida como estado atual. Descreve o comportamento desejado. Hoje o script apaga a flag com a fila corrompida (linhas :76-78).
- RE-12: omite que o dry-run e a saída "Nada a fazer" saem com 0 sem ver a fila (linhas :48-51 e :59-61).
- RE-13: omite a fila em falta, que também grava a flag (curationQueue.server.js:134-169).
- RE-14: "Revisão Lote 1, ponto 3". Não verificável no checkout.
- RE-15: pendentes do Lote 0. resetCorruptedQueueToEmpty (docs/decisoes.md:271) já não existe. Foi substituído por degradeUnrecoverableQueue. Continuam abertos os de :268 e :272.

DBG-25 (linha :116)
- RE-16: "Com a flag ativa, a leitura em cache é recusada." Está errado. Nenhum caminho de leitura recusa fila saudável (lib/health/dbDegraded.js:7-9; app/db.server.js:39-41; docs/decisoes.md:250; scripts/tests/publisher-price-policy.test.js:299-306).
- RE-17: o âmbito é loadCurationQueue em geral, não só a cache da variante.
- RE-18: "ponto 6" da revisão não existe no repositório.

DBG-26 (linha :117)
- RE-19: "nunca é exercitado". Está exagerado. scripts/tests/restore-db-degraded.test.js (:88-98 e :100-130) exercita o ramo com flag em pasta temporária. O que falta é a tarefa de CI.
- RE-20: "/tmp". Está errado. maintenance.sh:219 usa mktemp -d.
- RE-21: não diz que o resultado é igual com ou sem flag real. A linha "integrity_check da cópia" (maintenance.sh:391-393) não depende da flag do volume.
- RE-22: omite o "|| true" no WAL (maintenance.sh:224). É o defeito DBG-37.
- RE-23: omite que a cópia é de BD viva, sem parar a app e sem esperar pela indexação.
- RE-24: "ponto 7" da revisão não existe no repositório.

DBG-30 (linha :121)
- RE-25: "A gravação das falhas só é coberta pelo sweep". Está errado. Não há cobertura. O teste do sweep (curation-queue-guards.test.js:147-168) usa listas feitas à mão e não gera falhas.
- RE-26: a linha diz só que o laço não tem teste. Omite que o laço apaga antes de gravar localmente, que não para numa falha de gravação local (:448-461) e que sai cedo com loja vazia (:389-397).
- RE-27: "Até lá, sem reset em produção". É só regra de processo. scripts/catalog/shopify-products-purge.js:57 não lê a flag. A rota só guarda no arranque (api.shopify-reset.jsx:80-97).
- RE-28: "achado 8" não está confirmado no checkout. O git está bloqueado.
- RE-29: o cabeçalho de scripts/catalog/shopify-products-purge.js (linhas :11-12) diz que a fila volta a APPROVED. Está errado: põe PENDING com deletedInAdmin.

## 7. Erros da análise (não copiar para o briefing)

- AE-01 (DBG-04). A análise diz que a fusão protege SYNC_ERROR em :642-646 e :644. Está errado. Ver 2.6 (a).
- AE-02 (DBG-04). "Perda na retoma por janela entre flushes". Excessivo (R3).
- AE-03 (DBG-04). "Lote de 500" em catalogProductsDb.server.js:108-133. O lote deste ficheiro é 250 (linha :18). O 500 é STREAM_BATCH (syncCatalogWithProgress.server.js:37), de outra função.
- AE-04 (DBG-04). full-catalog-reindex.js:57 como escritor da fila. Não escreve. Ver R7.
- AE-05 (DBG-04). "250 ms com 29.601 itens" aplicado ao save atual. Não se aplica (ver 2.6 k).
- AE-06 (DBG-04). A VM da Fly sem memória configurada (DBG-14). Não verificado: fly.toml não foi aberto.
- AE-07 (DBG-21). "O único sinal automático é o não encontrado". Errado. marginErosion.server.js:192-194 corre fetchLiveVariantsBySku e diagnoseMissingLive em cada ciclo.
- AE-08 (DBG-21). Fix 3 contraditório. "Aceitar só PUBLISHED" e "REJECTED fica para a migração" são a mesma função. Ver 2.9.
- AE-09 (DBG-21). codeLocations diz que SYNC_ERROR é protegido em :644. Não é. Ver AE-01.
- AE-10 (DBG-21). Risco "falso apagado" tratado como sinal único. Exige também falha na pesquisa de variantes (R9).
- AE-11 (DBG-23). Causa raiz "A flag DB_DEGRADED não diz de onde vem o problema". Errado. A flag grava a causa (curationQueue.server.js:141, :153 e :288). O restauro imprime-a (linha :53) e não a compara. O defeito é ignorar a causa.
- AE-12 (DBG-23). "Com a flag presente lança antes de ler (:135-136 e :241)". Errado com ficheiro válido: loadCurationQueue (:87-113) não verifica a flag. A conclusão de não chamar loadCurationQueue() mantém-se, pela importação de Prisma.
- AE-13 (DBG-23). "maintenance.sh não lê o texto do restauro". Errado: a linha :391 lê "integrity_check" do texto para o rótulo do relatório. A conclusão não muda.
- AE-14 (DBG-26). Atribui o "|| true" a DBG-26. É defeito próprio (DBG-37).
- AE-15 (DBG-26). Diz que a regra do WAL é cumprida porque a ordem está certa. Só é cumprida com a cópia bem-sucedida.
- AE-16 (DBG-26). Proposta de printf com barra invertida a mais. Ver 2.5.
- AE-17 (DBG-30). "Não tem ponto de injeção. Por isso ninguém a testou." Não confirmado. É possível testar sem alterar produção, com o fetch global e variáveis de ambiente.
- AE-18 (DBG-30). R9 cita shopifyReset.server.js:226-227 e :255. O caminho real é :241-244 e :296, com applyDeletedInAdmin (curationQueue.server.js:1196-1214). A conclusão mantém-se.
- AE-19 (DBG-30). R5 diz que o trinco foi libertado em 09/09. O código não prova essa execução (R23).
- AE-20 (todos). Os resultados "hoje passa" e "hoje falha" dos testes propostos não foram executados.
- AE-21 (DBG-25). "Cópia suja" descrita como causa. É dedução do código, sem teste.

## 8. IDs, lacunas e fontes em falta

- DBG-37 está proposto para dois defeitos: o WAL (análise de DBG-26) e a cópia suja (verificação de DBG-25). Conflito. Este plano usa DBG-37 e DBG-38. [ID EM CONFLITO] [DECISÃO D46]
- Se o publicador com resolveVariantBySku virar DBG novo, usar DBG-39. [DECISÃO D16]
- DBG-21 não tem linha na secção 4 do relatório.
- DBG-32 é citado por DBG-30 (guarda de flag). Não analisado nestes resultados.
- DBG-06, DBG-09, DBG-15, DBG-05 e DBG-16 não são analisados nestes resultados. DBG-09 só aparece pela linha :57.
- Textos da revisão do Lote 1 (pontos 3, 6 e 7) não estão no checkout. Só existem as linhas do relatório (:114, :116 e :117). Se a revisão pedia outra coisa, os itens mudam.
- "Achado 8" de DBG-30 e o commit 41b4d66 (com pai 58a99fe) não foram verificados. O git está bloqueado.
- Decisões citadas pelas análises mas não relidas: Decisão 33 (pontos 3 e 4), Decisão 34 (pontos 2, 4, 8, 10, 14 e 15), docs/decisoes.md:264 e :227.
- Pendentes do Lote 0 em docs/decisoes.md (linhas :268 e :272): D23.

## 9. Decisões para o arquiteto

DBG-04
- D1. Escritor único por IPC (recomendado) ou lockfile entre processos com verificação de PID. O lockfile deixa lock órfão após SIGKILL ou OOM.
- D2. Regra de conflito: decisão humana no disco ganha sempre sobre o cálculo do worker. Vale também para rejeições vindas de AUTO_REJECT e para overrides de margem?
- D3. Reset Shopify e elite purge entram na mesma fila de escrita, ou bloqueiam enquanto houver indexação? A Decisão 28 nas sessões Prisma em massa não fica resolvida pela proposta.
- D4. Até à correção, bloquear aprovações e rejeições na UI enquanto isCatalogIndexingRunning for verdadeiro? Custo operacional para o Carlos.
- D5. O worker só avança o checkpoint depois de o principal confirmar o lote? (Sugerido pela verificação.)
- D6. A Decisão 29 vale no caminho em lote: SYNC_ERROR protegido na fusão? (Proposta: sim.)
- D7. Scripts de manutenção fora da app (curation-override-clear.js:70, não verificado): recusar com a app ativa, ou passar pelo mesmo escritor?
- D8. Prioridade de DBG-04 (P1 ou P2). Depende de medir R1. Decide o Carlos.

DBG-21
- D9. "O reconciliador" da Decisão 34, ponto 15: ciclo automático novo, ou só ação manual com prova por id?
- D10. Uma aprovação nova limpa deletedInAdmin e permite publicar, ou a retenção fica até remoção explícita? Hoje nada a limpa.
- D11. SYNC_ERROR pode ir a PENDING por markQueueItemDeletedInAdmin, pela migração (deletedMigration.js:12), pelo reset (shopifyReset.server.js:245-250 e :292-296) e pelo revert (:227; curation-revert-published.js:28 e :63)? A Decisão 29 só lista três transições manuais.
- D12. A aprovação em massa de itens apagados (bulkTransitionPending) fica como está, ou pede confirmação por item?
- D13. PUBLISHED sem shopifyProductId: recebem marca quando a loja não os tem (product(id) null), ou ficam como estão? A Decisão 34, ponto 14, fixa só a escalada P0.
- D14. Limiar de aborto de 5 % para reconciliador e sweep (Decisão 34, ponto 8).
- D15. A regra de 09/10 deve ser escrita em docs/decisoes.md, com conteúdo: PENDING, nunca APPROVED, volta só com aprovação nova. Hoje só referida (:264 e :227).
- D16. O publicador com resolveVariantBySku (shopifyProductPublisher.server.js:322), com duplicado na loja não verificado, vira DBG novo com severidade P0, ou fica no DBG-21?
- D17. Decisão 28 na publicação agendada (api.trigger-sync.jsx:210) e no reconciliador: guarda isShopifySyncRunning?

DBG-23, DBG-26 e WAL
- D18. Decisão 34, ponto 4 (docs/decisoes.md:251): acrescentar "a fila lê sem erro", ou critério próprio por causa da flag?
- D19. Fila sanitizável (JSON com caracteres de controlo): o restauro deixa passar ou recusa? Proposta: recusar até decisão.
- D20. Fila em falta: recusar sempre, ou aplicar a regra do catálogo (que pede contagem na BD, que o script não faz)? Proposta: recusar.
- D21. A fila faz parte do snapshot de restauro? Se sim, o procedimento manual (restore-db-degraded.js:15) repõe curation-queue.json, e convém comparar fila e BD.
- D22. O dry-run deve recusar com fila corrompida? Proposta: sim. Decidir também se a verificação da fila corre sem flag (saída "Nada a fazer", :48-51). E como a Decisão 28 protege a sessão Prisma de restore-db-degraded.js:24.
- D23. Pendentes de docs/decisoes.md: :268 (o restauro deve exigir flag limpa antes de db:push?) e :272 (leitura da fila em modo degradado deve falhar à vista?).
- D24. Como a fila chega ao runner de CI. maintenance.sh copia só dev.sqlite e o WAL e não define CURATION_DATA_DIR.
- D25. restore_dry_run lê o estado real da flag do volume (ausente, presente, ilegível), só para mostrar o estado? Proposta: sim, com UNKNOWN em RC=2.
- D26. Cópia consistente de BD em WAL viva: (a) parar a app, com OK do arquiteto; (b) backup SQLite ou VACUUM INTO por fly ssh, sob a Decisão 28; (c) aceitar cópia sem garantia e dizê-lo no resumo.
- D27. restore_dry_run deve esperar pela indexação, como db_push (maintenance.sh:241)?
- D28. Flag sintética na cópia (proposta) ou flag real copiada?
- D29. Ramo degradado que não corre é falha (RC=1)? Proposta: sim. Aceitar o ponto de injeção necessário para o teste.
- D30. DBG-37 (maintenance.sh:224, "|| true") como item próprio, P2? Proposta: sim, com o teste de WAL presente e cópia falhada.

DBG-25 e modo degradado
- D31. Política de leitura em modo degradado: confirmar a Decisão 34 (leituras passam). Recomendação: manter, e retirar a expectativa de DBG-25 no relatório.
- D32. Severidade e ID do defeito de cópia suja (DBG-38): P1 ou P2. A verificação sustenta um ID novo.
- D33. Reinício da app depois do restauro: obrigatório, ou basta a correção de 2.1? Os deploys reiniciam o processo.
- D34. Leitura de fila corrompida com flag presente passa a recusar (painel blocked, catálogo falha). Regra única para fila saudável, em falta e corrompida (docs/decisoes.md:272).

DBG-30
- D35. Gravação local falha depois de apagamento na Shopify: continuar (estado atual) ou parar? Recomendação técnica: parar.
- D36. Onde fica a guarda DB_DEGRADED: só na rota (estado atual), ou dentro de runShopifyCatalogReset (cobre scripts e DBG-32)?
- D37. Loja vazia: a varredura corre e marca os PUBLISHED como apagados? O comentário (:335-337) diz que sim. O código (:389-397) não. Confirmar a regra antes de mudar.
- D38. Limite de falhas seguidas: quantas, e o que acontece (abortar ou pausar)?
- D39. Trinco órfão: libertação manual com reset-lock-release.js, ou batimento com expiração automática?
- D40. Gravação da fila por produto (atual) ou por lote de 20?
- D41. Testes: sem mudar código (recomendado para o primeiro passo), ou ponto de injeção (setCatalogCountReaderForTests)?
- D42. Ciclo agendado: guarda de reset em curso (409, como api.shopify-sync.jsx:121)? Muda o relógio.
- D43. A Decisão 28 abrange a publicação agendada? Hoje só a rota manual guarda contra o reset.
- D44. revertAllPublishedInQueue põe SYNC_ERROR em PENDING (shopifyReset.server.js:235 e :243-248). Esse caminho sai, ou a Decisão 29 passa a incluir o reset? Decisão do Carlos.

Transversais
- D45. Execuções de produção (curation-mark-deleted --execute, "Aplicar aos publicados", curation-requeue-deleted.js, shopify-products-purge.js --execute): OK do arquiteto (Decisão 33, ponto 3) e registo em docs/execucoes.md (Decisão 34, ponto 10). Confirmar para cada script.
- D46. Atribuir IDs: DBG-37 proposto para o WAL e para a cópia suja. Atribuir também o publicador (D16). DBG-32 é citado por DBG-30 e fica por analisar.

## 10. Resumo para o briefing

- Doc PR 41b4d66 primeiro (0.1). Depois corrigir o relatório (0.3).
- Testes antes de correções (fase 1). Nenhum defeito entra sem teste.
- Ordem das correções: DBG-25 (2.1), DBG-21 parte A (2.2), DBG-23 (2.3), DBG-37 (2.4), DBG-26 (2.5), DBG-04 (2.6), DBG-30 parte 2-4 (2.7), DBG-30 parte 5-7 (2.8), DBG-21 parte B (2.9), varredura (2.10), reconciliador (2.11, só se D9).
- Bloqueia: DBG-04 precisa de D1, D2, D5, D6. DBG-30 5-7 e DBG-21 B precisam do escritor único (2.6).
- Não implementar nenhum fix marcado [FIX NÃO SEGURO] sem reverificação.

## 11. Resposta do arquiteto (15/10) e estado das decisões

Estado: 0.1 feito (PR #106, merge em `main` no SHA `0dba4a7`). Os IDs provisórios foram substituídos: DBG-NOVO-WAL passa a DBG-37, DBG-NOVO-CACHE a DBG-38, DBG-NOVO-PUB a DBG-39. Parar antes de implementar foi aceite. O cético por item fica como prática.

### Decisões fechadas

- D1: IPC. O worker deixa de escrever a fila e envia cada alteração ao processo principal por `process.send`. O principal é o único escritor.
- D2: a decisão humana ganha. Cada item guarda `statusChangedAt`. Uma escrita do worker com leitura anterior a essa data não toca no estado, só atualiza campos de catálogo.
- D6: o worker nunca muda o estado de itens APPROVED, PUBLISHED ou SYNC_ERROR. Só cria itens PENDING novos e atualiza metadados.
- D30: o `|| true` do WAL sai como DBG-37, em PR próprio e já.
- DBG-25: avança com as três condições desta secção (passo 2.1).
- DBG-37: a falha na cópia do WAL faz falhar `restore_dry_run` com mensagem explícita. WAL ausente aparece como "sem WAL", separado de falha de cópia. Teste com `flyctl` falso para os dois casos.

### Git

- Não se reescreve nenhum branch remoto.
- Cada PR nasce num branch novo a partir de `main`: `claude/lote2-2b-docs`, `claude/dbg-37-wal`, `claude/lote2-2b-1`, `claude/lote2-2b-2`, `claude/lote2-2b-3`.
- Push normal, sem força.

### Quem decide

O developer decide tudo o que não muda transições de estado, dados em produção ou o reset. Sobe ao arquiteto o que muda estado de itens, apaga ou escreve na loja, ou mexe no restauro.

| Decisão | Tipo | Quem decide | Estado |
|---|---|---|---|
| D1, D2, D6, D30 | estado / arquitetura | arquiteto | decidido |
| D3 reset e purga na mesma fila | reset | arquiteto | decidido na Decisão 35 |
| D4 bloquear UI de aprovação durante indexação | UI que muda estado | arquiteto | decidido na Decisão 35 |
| D5 checkpoint só depois de confirmação | técnico | developer | sim |
| D7 scripts fora da app que escrevem a fila | escrita da fila | arquiteto | decidido na Decisão 35 |
| D8 prioridade de DBG-04 | etiqueta | developer | P1 |
| D9 reconciliador como ciclo automático | escrita de estado | arquiteto | decidido na Decisão 35 |
| D10 aprovação limpa `deletedInAdmin` | estado | arquiteto | decidido na Decisão 35 |
| D11 transições de SYNC_ERROR | estado | arquiteto | decidido na Decisão 35 |
| D12 aprovação em massa de apagados | estado | arquiteto | decidido na Decisão 35 |
| D13 PUBLISHED sem `shopifyProductId` | estado | arquiteto | decidido na Decisão 35 |
| D14 limiar de 5 % | técnico | developer | 5 % (Decisão 34, ponto 8) |
| D15 escrever a regra de 09/10 em `docs/decisoes.md` | regra | arquiteto | decidido na Decisão 35 |
| D16 publicador com duplicado | severidade | developer | DBG-39, P0 suspeito |
| D17 guarda da Decisão 28 na publicação agendada | técnico | developer | sim |
| D18 a D24 e D26 a D29 | restauro | arquiteto | decidido na Decisão 35 |
| D25 e D28 | restauro (leitura da flag e cópia sintética) | arquiteto | decidido na Decisão 35 |
| D31 Decisão 34: leituras passam em modo degradado | política | arquiteto | decidido: mantém |
| D32 severidade de DBG-38 | severidade | developer | P2 |
| D33 reinício depois do restauro | restauro | arquiteto | decidido na Decisão 35 |
| D34 fila corrompida com flag recusa leitura | leitura | arquiteto | decidido pela condição (c) de DBG-25 |
| D35 a D40 | reset | arquiteto | decidido na Decisão 35 |
| D41 testes sem mudar código | técnico | developer | sim, no primeiro passo |
| D42 guarda de reset no ciclo agendado | reset | arquiteto | decidido na Decisão 35 |
| D43 Decisão 28 na publicação agendada | técnico | developer | sim |
| D44 `revertAllPublishedInQueue` e SYNC_ERROR | estado | arquiteto | decidido na Decisão 35 |
| D45 execuções de produção | produção | arquiteto | aplica-se a regra existente |
| D46 IDs | nomeação | developer | DBG-37, DBG-38, DBG-39 |

### Divisão em PRs

| PR | Conteúdo | Dependências |
|---|---|---|
| `claude/lote2-2b-docs` | Este plano e as correções do relatório | nenhuma |
| `claude/dbg-37-wal` | DBG-37 | nenhuma |
| `claude/lote2-2b-1` | DBG-04 com D1, D2 e D6 | D3, D7 pendentes ficam fora: os escritores de reset e de scripts mantêm o comportamento atual até decisão |
| `claude/lote2-2b-2` | DBG-21, DBG-23, DBG-25, DBG-26 | D9 a D13, D15, D18 a D29, D33 |
| `claude/lote2-2b-3` | DBG-30, com o teste do laço do reset | D35 a D44 |

Cada PR: testes antes das correções, mutação em cada teste, revisão adversarial, CI verde, merge com head SHA lido do GitHub, deploy depois do merge, e verificações pós-deploy (`db_flag_check`, `catalog_health`, `logs_recent`). O deploy de cada PR fica à espera da aprovação do Carlos.

### Atualização de 15/10 (segunda resposta do arquiteto)

As decisões que estavam pendentes na tabela acima foram fechadas e estão na Decisão 35 de `docs/decisoes.md`. Esta tabela fica como registo histórico do que foi perguntado.
