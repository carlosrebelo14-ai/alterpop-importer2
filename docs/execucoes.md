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
