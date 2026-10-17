# Runbook do deploy

Este ficheiro não existia no repositório. Foi criado em 17/10 com a regra da Decisão 38 (`docs/decisoes.md`).

## Antes do deploy

- `main` tem o PR que se quer publicar, e o CI está verde.
- Não há indexação a correr. A partir do PR 1 (DBG-156), o workflow `deploy` espera até 15 min antes de chamar `flyctl deploy`, e falha sem fazer deploy se a indexação não acabar.
- O deploy só corre com o ok do arquiteto e a aprovação do Carlos no environment `production`.

## Se o gate `catalog_health` do deploy der vermelho

- O gate corre logo depois do arranque. Se uma indexação começar nesse momento, o gate pode avaliar o catálogo a meio. Sinal típico: V5, V6 e V7 em vermelho, com a sonda a não ter visto `running` em disco (DBG-156).
- Regra: esperar que a indexação acabe. Depois repetir o `catalog_health` à mão, com o workflow `maintenance`, tarefa `catalog_health`, modo `dry-run`.
- Só se dá o deploy por bom quando o `catalog_health` repetido ficar verde.
- Não se repete com `db_push`.

## Vetos ativos

- Tarefa `db_push` em modo `execute`: até o DBG-156 estar em produção (Decisão 37).
- `scripts/catalog/full-catalog-reindex.js`: até o 2b-3 estar em produção (Decisão 36).
- `scripts/catalog/run-approved-sync.js`: até haver exclusão real entre processos (Decisão 38, DBG-142 no 2c).
- Reset: ver Decisão 35.
