# Runbook do deploy

Este ficheiro não existia no repositório. Foi criado em 17/10 com a regra da Decisão 38 (`docs/decisoes.md`).

## Efeitos do PR 5 no deploy

Os passos desta secção são propostos, a confirmar pelo arquiteto.

- O worker de indexação sai quando o processo principal desaparece. Um reinício do principal, incluindo o que o deploy faz à máquina, corta a indexação em curso. A purga do catálogo corre no mesmo worker e sai com ele.
- O estado fica em `running` no disco. Nada no arranque corrige o ficheiro de estado. O estado sai de `running` só com uma nova indexação completa, ou com `RESUME=1` à mão. Até o veto da Decisão 36 ser levantado, o `RESUME=1` não se usa em produção.
- Enquanto o estado estiver em `running`, o gate e o db:push recusam (ver "Risco que sobra").

Verificação pós-deploy:

1. Correr `ps` na máquina da Fly, por ssh, e confirmar que não há worker órfão: nenhum processo `catalog-index-worker` sem indexação em curso.
2. Confirmar que a pasta de marcadores (`catalog-busy-*.json`) não tem marcadores com pid morto.
3. Confirmar que `indexing_status` não mostra `running` preso. Se mostrar, não repetir o deploy: tratar com o arquiteto, como em "Risco que sobra".

## Antes do deploy

- `main` tem o PR que se quer publicar, e o CI está verde.
- Não há indexação a correr. A partir do PR 1 (DBG-156), o `scripts/deploy.sh` espera até 15 min, logo antes do `flyctl deploy`, com a mesma sonda do `catalog_health`. Se a indexação não acabar, o deploy para sem chamar o `flyctl`. Vale também para o deploy manual, `bash scripts/deploy.sh`.
- O deploy só corre com o ok do arquiteto e a aprovação do Carlos no environment `production`. O job `deploy` tem 90 min de limite.

## Se a espera ou o gate falharem com erro de ssh

- Uma falha de `flyctl ssh` (estado ilegível, código 2) na espera antes do deploy, ou no `catalog_health`, resolve-se repetindo o passo. Não se mexe em mais nada: não há estado a limpar, e o deploy não correu.
- A falha é fechada de propósito. Sem leitura do estado, o deploy não avança.

## Risco que sobra (ronda 2: DBG-154 e DBG-155)

- Uma indexação que arranca depois da espera, durante o build e o rollout da Fly, não é vista. O `flyctl deploy` reinicia a máquina e pode matar o worker a meio.
- Um worker morto não escreve estado final. O ficheiro de estado fica em `running`. Efeitos: o gate e o `db:push` recusam até um run novo acabar e limpar o estado, e o catálogo fica meio reconstruído, porque `canResumeCatalogRebuild` só aceita `failed` ou `interrupted`.
- Sinal: `catalog_health` falha depois do deploy com V5, V6 e V7, ou `indexing_status` mostra `running` sem worker vivo. Ação: não repetir o deploy. Tratar o estado com o arquiteto.

## Se o gate `catalog_health` do deploy der vermelho

- O gate corre logo depois do arranque. Se uma indexação começar nesse momento, o gate pode avaliar o catálogo a meio. Sinal típico: V5, V6 e V7 em vermelho, com a sonda a não ter visto `running` em disco (DBG-156).
- Regra: esperar que a indexação acabe. Depois repetir o `catalog_health` à mão, com o workflow `maintenance`, tarefa `catalog_health`, modo `dry-run`.
- Só se dá o deploy por bom quando o `catalog_health` repetido ficar verde.
- Não se repete com `db_push`.

## Ler a última falha da indexação (`indexing_status`)

- `falha_em`: data da última falha. `falha_causa`: causa, em lista fechada (`worker_saiu`, `worker_morto`, `erro_worker`, `erro_pai`, `marcador`, `estado_nao_gravado`, `erro_script`). `falha_classe`: classe do texto do erro. `nenhuma` quando não há falha registada.
- `totalRejected`: linhas rejeitadas na última corrida.
- O texto do erro não sai em lado nenhum. Fica no ficheiro de estado (`lastFailure.error`), e lê-se com acesso direto ao volume da Fly, nunca por esta tarefa.
- Uma corrida concluída não apaga a falha anterior. A falha seguinte substitui-a.

## Vetos ativos

- ~~Tarefa `db_push` em modo `execute`~~: levantado em 17/10, DBG-156 em produção (Decisão 37, deploy run `39055860291`).
- `scripts/catalog/full-catalog-reindex.js`: até o PR 5 estar em produção e verificado (Decisão 36).
- `scripts/catalog/run-approved-sync.js`: até haver exclusão real entre processos (Decisão 38, DBG-142 no 2c).
- Reset: ver Decisão 35.
