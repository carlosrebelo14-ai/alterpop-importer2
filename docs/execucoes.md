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
