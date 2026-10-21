# Plano do 2c

**Estado:** em execução. Base: `main` em `d317d46` (merge do PR #129, deploy `39589043384` verde). A verificação pós-deploy é do arquiteto.
**Origem:** relatório `docs/relatorios/debug-geral-14-10-2026.md`, decisões do arquiteto de 21/10 e Decisão 33, ponto 1.

## Âmbito

| Item | Sev | O que muda | Decisão |
|---|---|---|---|
| DBG-180 | Alta | Tempo limite em todas as chamadas à Shopify do caminho do reset. Uma chamada que esgota o tempo marca o reset como `failed` e retomável. | Arquiteto, 21/10 |
| DBG-178 | Média | Um reset `failed` também é retomável, com os contadores da tentativa anterior. | Consequência do DBG-180 |
| DBG-142 | Alta | Exclusão real entre processos na publicação. O veto a `scripts/catalog/run-approved-sync.js` mantém-se. | Decisão 38 |
| DBG-05 | P1 | Um helper único de resolução de `locationId`, usado pelo publisher e pelo sync de stock. | Relatório |
| DBG-47 | 2c | Decisão 28 nas rotas: nenhuma sessão de leitura em paralelo com a publicação. | Relatório |
| DBG-123 | Média | Quando a aprovação falha por outro motivo, o override não fica gravado sem aviso. | Relatório |
| DBG-16 | P2 | Produto descontinuado no feed sai da loja e entra numa lista no painel para o Carlos escolher substituto. É código. | Decisão 33, ponto 1 |

## Ordem

Uma ronda por PR. Cada ronda tem os seus testes, e cada correção que bloqueia tem mutação.

1. **DBG-180 e DBG-178.** Base de segurança do reset. Sem tempo limite, a retoma depois de um pedido pendurado não tem onde começar. Mutações: sem o sinal de tempo limite, sem o relançamento no laço de apagamento, e retoma só de estados ativos.
2. **DBG-142.** Pré-requisito do reset e da publicação em paralelo. O marcador de publicação é em memória, e não cruza processos. Ponto a aprovar antes do código: desenho do lock (ver abaixo).
3. **DBG-47.** Leituras nas rotas em paralelo com a publicação.
4. **DBG-05.** Helper único de location.
5. **DBG-123.** Override na aprovação falhada.
6. **DBG-16.** Código. Dry-run primeiro, lista no painel, e `--execute` só com OK do arquiteto (Decisão 33, ponto 3).

## Gates por PR

- `test:franchise`, `test:sync-safety`, `test:health-gate` e `test:deploy`.
- As mutações do PR, cada uma com caso vermelho.
- Deploy só depois do merge, com aprovação do Carlos no environment `production`, e verificação do arquiteto.

## Restrições

- O reset em produção continua vetado (Decisão 35) até o fim do 2c.
- `run-approved-sync.js` continua proibido em produção até o DBG-142 estar fechado.

## Pontos a aprovar antes do código

- **DBG-142, desenho.** Proposta: a publicação (ciclo, rota manual e script) toma um lock de ficheiro entre processos com o mesmo módulo do trinco de arranque, `curationQueueFileLock`, e o reset e a purga tomam o mesmo lock. A exclusão passa a ser real, e não depende de memória.
- **DBG-16, lista no painel.** A lista sai dos produtos despublicados pelo feed, e a escolha do substituto fica registada. Falta confirmar o formato da lista com o Carlos.
