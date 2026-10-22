# Registo de execuções com `--execute`

Cada `--execute` contra produção fica registado aqui antes de a corrida começar (Decisão 34, ponto 10).

Cada entrada tem:

- data e hora (UTC)
- comando completo
- contagens do dry-run (processadas, total, afetadas)
- referência ao OK do arquiteto (data e resposta, ou link ao chat de arquitetura)
- resultado da corrida, preenchido depois

Sem entrada, sem `--execute`.

---

## Execuções com `--execute`

- **2026-10-20, `scale_memory` contra produção (run `39479976113`, workflow `maintenance`).**
  - Comando: `task=scale_memory`, `mode=execute`, ref `main` em `d86c161`. Dentro do runner: `flyctl machine update <id da máquina 85e132…> --vm-memory 1024 --yes -a alterpop-importer-app`, seguido de `machines list` para confirmar.
  - Dry-run antes (run `39479386412`): 1 máquina, `85e132…`, `started`, 512 MB, `shared` × 1. Com o execute, passava a 1024 MB, com reinício.
  - OK do arquiteto: PR #128 aprovado em `24147bb`, e pedido explícito de execute depois do dry-run verde, na mensagem de 20/10. Aprovação do environment `production`: Carlos.
  - Resultado: sucesso. 512 para 1024 MB, máquina `started`, confirmado pela Fly. Sem `--execute` posterior nesta tarefa.
  - Decisão 41. A troca reinicia a máquina. O estado preso só passou a `completed` com a indexação do ciclo que arrancou às 19:16:57Z, depois da troca (leitura `indexing_status` de run `39483861712`, fim às 19:19:21Z).

- **2026-10-22, `reset_execute` contra produção (run `39814627500`, run number 107, workflow `maintenance`).**
  - Comando: `task=reset_execute`, `mode=execute`, `ok=6139ac643a25`, ref `main` em `20de1a3` (merge do #142). Dentro do runner: o driver `scripts/maintenance/reset-maintenance.mjs` em `RESET_MODO=execute`, com a reserva de publicação tomada e o reset chamado com `reservaTomada`.
  - Dry-run antes (run `39814245832`, run number 106, mesmo `20de1a3`): 57 produtos na loja e 57 na lista a apagar, iguais. Impressão digital `6139ac643a25`.
  - OK do arquiteto: revisão do dry-run (57/57 iguais) e ordem de disparar o execute com `ok=6139ac643a25`, na conversa de 22/10.
  - Resultado: `conclusion` success. Verificado pelo arquiteto depois da corrida: restantes na loja 0, PUBLISHED 0, falhados 0. `productsCount` na Shopify 0. `active_vs_queue` (run `39818851357`): 0 ACTIVE.
  - Decisão 35 levantada pelo arquiteto depois desta verificação.
  - Anomalia no resumo: o execute diz apagados 64 e revertidos 64 para uma lista de 57. Ver a nota de 22/10 sobre a anomalia.

## Notas sem `--execute`

- **2026-10-16, merge do #111 antes da decisão sobre os pendentes.** O merge do #111 em `main` (`bc76f06`) foi feito antes de o arquiteto decidir os pendentes de `37bab0e`. O deploy não correu nessa altura. O deploy de `main` só correu depois do #113 (`f32b065`), com aprovação do Carlos no environment `production`. Sem impacto em produção antes desse deploy. Sem `--execute` nesta nota.
- **2026-10-17, proibição do script CLI de publicação (DBG-142).** `scripts/catalog/run-approved-sync.js` fica proibido em produção até ao 2b-3, como o reset e a purga. A reserva em memória da app não o vê, e a app não lê o marcador de atividade do script. Decisão do arquiteto. Sem `--execute` nesta nota.
- **2026-10-17, deploy de e575971 (#116), run `39035938600`.** O `flyctl deploy` acabou com sucesso, e a máquina `85e132a4451358` ficou boa às 15:30:53Z. O passo `catalog_health` falhou às 15:31:04Z com 13 verdes, 3 vermelhas (V5, V6 e V7). Falso alarme: o gate correu durante o `clearing` da indexação iniciada logo após o arranque (DBG-156). Verificação manual, sem `--execute`: `catalog_health` 16/0/0 (run `39049237925`), `active_vs_queue` 57/57 PUBLISHED (run `39049337131`), `db_flag_check` ausente (run `39049449202`), `logs_recent` limpo, com ciclo concluído às 16:18:14Z em 139 s (run `39049161329`). O #116 fica fechado.
- **2026-10-17, merge do #117 (`indexing_status`), sem deploy.** Merge commit `a797e703`, travado em `60ba00c`. Dry-run da tarefa `indexing_status` (run `39049688832`): concluída sem erros. Estado `completed`, classe de erro `nenhum`, início `16:15:56.161Z`, fim `16:18:15.005Z`, 26087 linhas indexadas, checkpoint nulo. Sem `--execute`.
- **2026-10-17, DBG-142 passa para o 2c.** O veto de `scripts/catalog/run-approved-sync.js` mantém-se até haver exclusão real entre processos (Decisão 38). Sem `--execute` nesta nota.
- **2026-10-17, ronda 1 em produção (#119 e #120), deploy run `39055860291`, `main` em `fbf0a24`.** Verde, com `catalog_health` no próprio job. Verificação pós-deploy, sem `--execute`: `active_vs_queue` 57/57 PUBLISHED (run `39057242213`), `logs_recent` limpo (run `39057174502`), `indexing_status` completed, classe `nenhum`, 26087 linhas (run `39057333831`), `db_flag_check` ausente (run `39057413157`). A espera do `scripts/deploy.sh` não foi exercitada: a última indexação acabou às 17:48:19Z, antes do deploy. Decisão 37 levantada. #121 fundido em `ac96e58`, travado em `23adad3`, sem deploy.
- **2026-10-17, ronda 2 em produção (#123), deploy run `39064527768`, `main` em `67beccf`.** Verde, com `catalog_health` no próprio job (16 verdes, 0 vermelhos, 0 avisos, às 20:06:03Z). Verificação pós-deploy, sem `--execute`: `active_vs_queue` 57/57 PUBLISHED (run `39065542908`), `indexing_status` completed, classe `nenhum`, 26087 linhas, início 20:00:59Z, fim 20:03:22Z (run `39065465073`), `logs_recent` limpo (run `39065582161`). `db_flag_check` não reportado nesta ronda. Primeira prova real do DBG-156. No job `117489258220`, a espera do `scripts/deploy.sh` apanhou a indexação: tentativa 1 às 20:01:47Z, tentativa 2 às 20:02:49Z, `espera ok` às 20:04:07Z, cerca de 2 min de espera. O `flyctl deploy` acabou às 20:05:41Z. A indexação começou durante os guardas da suíte, antes da espera.
- **2026-10-17, merge do #124 (PR 4, DBG-155), sem deploy.** Merge commit `4e5d8ed`, travado em `b434a01`, com CI verde no head (run `39066856083`). O commit `b434a01` é o teste da marca no arranque com flush falhado, pedido na revisão. Próximo: PR 5 (DBG-140 e DBG-141), com a guarda contra script de reindexação.
- **2026-10-20, ronda 3 do PR 5 em produção (#125, merge `49c056a`, deploy run `39444758942`).** Deploy verde. Verificação pós-deploy, sem `--execute`: `active_vs_queue` 57/57 PUBLISHED (run `39447351238`); `logs_recent` limpo (run `39447660984`). Caixa negra: `indexing_status` (run `39447507798`): estado `failed`, causa `worker_morto`, de 14:46:56Z a 14:49:27Z, antes do deploy (15:02Z). `checkpointScanned` 24550, `totalRows` 26227, `totalRejected` 4305. Hipótese principal: OOM killer da Fly, ligado ao DBG-14 (memória). Pode explicar também o DBG-152 de 17/10. Confirmação pela tarefa `machine_status` (PR desta ronda) e pela contagem de OOM do `logs_recent`. A ronda 4 fica em espera até o Carlos decidir.
- **2026-10-20, deploy `39484366450` (`main` em `d86c161`, PR #128, Decisão 41).** Aprovado pelo Carlos no environment `production` às 21:06:36Z. Guardas verdes (`test:franchise`, `test:sync-safety`, `test:health-gate`). Espera por indexação: `[deploy] espera ok — sem indexação a decorrer`. `flyctl deploy` acabou às 21:14Z: máquina `85e132…` atualizada e `started`. `catalog_health` no próprio job: 16 verdes, 0 vermelhas, 0 avisos. Verificação pós-deploy, sem `--execute`: `machine_status` (run `39502538172`): 1 máquina, `started`, 1024 MB, sem saída desde o deploy. `active_vs_queue` (run `39502647580`): 57/57 PUBLISHED. `indexing_status` (run `39502758187`): completed das 21:31:58Z às 21:34:20Z, 26259 linhas, erro nenhum, `totalRejected` 4293. A Decisão 40 fica cumprida, e o estado preso fica limpo.
- **2026-10-22, deploy único do 2c (run `39754688740`, run number 30, `main` em `605e20a`).** PRs #130 a #137: DBG-180, DBG-178, DBG-142, DBG-05, DBG-47, DBG-123, DBG-193 e DBG-16. Aprovado pelo arquiteto. Deploy 39754688740 com success às 09:31Z, em 605e20a. machine_status (runs 39756561634 e 39757867049): 1 máquina, started, 1024 MB, 0 OOM. active_vs_queue (runs 39756628399 e 39757811384): 57/57 PUBLISHED. indexing_status (run 39757569589): completed, de 09:32:19Z a 09:42:13Z, 26180 linhas, sem erro. logs_recent (run 39757761328): 0 DbDegraded, 0 recusas, 0 reinícios, 0 OOM, 0 ciclos que não publicaram. Lacuna: logs_recent não conta falhas do stock dos publicados nem a linha «trinco de publicação perdido»; fica para o lote 3. A indexação passou de 135 s para 593 s; também para o lote 3. Lote 2 fechado a 22/10. Verificação pós-deploy pelo arquiteto: a linha `[trigger-sync] stock de publicados` com 0 falhas. Continuam vetados: o reset, o `scripts/catalog/run-approved-sync.js` e o `--execute` do DBG-16. **Rollback: `d317d46` (run `39589043384`, `success`, 21/10).**
- **2026-10-22, dry-run do reset (run `39814245832`, run number 106, `main` em `20de1a3`).** Antes do execute. 57 produtos na loja e 57 na lista a apagar, iguais. Impressão digital `6139ac643a25`. Sem `--execute` nesta nota.
- **2026-10-22, `active_vs_queue` depois do reset (run `39818851357`).** 0 ACTIVE. Sem `--execute` nesta nota.
- **2026-10-22, anomalia nas contagens do execute (run `39814627500`).** O resumo diz apagados 64 e revertidos 64, com 57 produtos na lista. O driver imprime `deleted` e `revertedLocal` do motor, que são acumulados entre tentativas. Em `initShopifyResetJob` (`lib/importer/shopify/shopifyResetJob.server.js`), quando uma tentativa retoma outra, `deleted` e `revertedLocal` começam nos valores do job anterior (DBG-178). Causa provável, ainda não confirmada: falta ler o ficheiro de estado de produção. A tarefa `reset_status` (no branch `claude/reset-status-leitura`, por fundir) faz essa leitura. Registo como DBG depois da confirmação. A correção, mostrar no resumo só os contadores desta tentativa, fica para depois. Sem `--execute` nesta nota.
