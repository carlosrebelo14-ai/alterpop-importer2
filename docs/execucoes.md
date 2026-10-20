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
