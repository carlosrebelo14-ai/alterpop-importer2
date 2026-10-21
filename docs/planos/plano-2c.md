# Plano do 2c

**Estado:** em execução. Base: `main` em `50059ed` (PR #131 mergeado, sem deploy).
**Origem:** relatório `docs/relatorios/debug-geral-14-10-2026.md`, decisões do arquiteto de 21/10, Decisão 33 ponto 1 e Decisão 42.

## Âmbito

| Item | Sev | O que muda | Estado |
|---|---|---|---|
| DBG-180 | Alta | Tempo limite nas chamadas da Shopify do reset. Chamada que esgota o tempo marca o reset como `failed` e retomável. | Mergeado em `9f8b1d7` (PR #130) |
| DBG-178 | Média | Reset `failed` retomável, com os contadores da tentativa anterior. | Mergeado em `9f8b1d7` (PR #130) |
| DBG-142 | Alta | Publicação exclusiva entre processos: publicação manual, ciclo, reset e `run-approved-sync.js` tomam o mesmo trinco de ficheiro. | Mergeado em `50059ed` (PR #131) |
| DBG-05 | P1 | Helper único de resolução de `locationId`, usado pelo publisher e pelo sync de stock. | Por fazer |
| DBG-47 | 2c | Decisão 28 nas rotas: nenhuma sessão de leitura em paralelo com a publicação. | Feito no 2c-4: o ciclo para sem reserva, e a escrita de preços e o radar tomam a reserva. Registado: DBG-203 a DBG-206. |
| DBG-123 | Média | Quando a aprovação falha por outro motivo, o override não fica gravado sem aviso. | Feito no 2c-5: a linha diz que o override ficou gravado, para qualquer causa. A gravação continua antes da aprovação (DBG-207). |
| DBG-193 | Média | Os passos do ciclo que escrevem na Shopify depois da publicação passam a correr com o mesmo trinco. | Feito no 2c-6, a aguardar OK do arquiteto. O ciclo segura o trinco até ao último passo de escrita, com confirmação antes de cada passo. Gate do reset: DBG-193 verificado em produção. |
| DBG-16 | P2 | Produto descontinuado no feed sai da loja e entra numa lista no painel para escolha de substituto. | Feito no 2c-7, a aguardar OK do arquiteto. Dry-run primeiro. `--execute` só com OK e com a linha em `docs/execucoes.md`. Pontos em aberto no relatório. |

## Ordem

Decidida pelo arquiteto em 21/10. Uma ronda por PR, com Decisão 39 em cada um: revisão inicial, e lente de delta do arquiteto.

1. **DBG-180 e DBG-178.** Feito (PR #130).
2. **DBG-142.** Feito (PR #131). O reset também toma o trinco, extensão aprovada pelo arquiteto. O veto ao `run-approved-sync.js` mantém-se até a verificação em produção e o fecho do DBG-197.
3. **DBG-05.** Helper único de location.
4. **DBG-47.** Decisão 28 nas rotas.
5. **DBG-123.** Override na aprovação falhada.
6. **DBG-193.** O ciclo segura a reserva entre processos desde a publicação até ao último passo que escreve na Shopify, com `aindaTem()` antes de cada passo. Ocupado, o ciclo salta com registo, como já faz. Gate do reset: DBG-193 verificado em produção.
7. **DBG-16.** Código. Dry-run primeiro. `--execute` só com OK do arquiteto (Decisão 33, ponto 3).

## DBG-16, formato aprovado em 21/10

O Carlos pode ajustar mais tarde.

- Despublicar = status `DRAFT` na Shopify. Nunca apagar, para manter URL e histórico.
- Secção "Descontinuados" no painel: imagem, título, SKU, franquia e data em que saiu do feed.
- Até 3 substitutos por produto: mesma franquia e mesmo formato, preço a mais ou menos 30%, só do catálogo disponível, por ordem de preço mais próximo.
- Botões "Usar este" (põe o substituto na fila como `PENDING`, marcado para aprovação, sem publicar) e "Ignorar" (tira o produto da lista).
- Nada é publicado sem aprovação do Carlos.

## Reset (Decisão 42)

- Sem republicação em lotes. O reset termina na verificação final: zero produtos da app na loja e zero `PUBLISHED` na fila.
- Os itens publicados voltam a `PENDING` com origem `reset`. O reset nunca os põe em `APPROVED`. O Carlos escolhe e aprova pelo painel o que quiser.
- A seleção dos produtos é do Carlos. Nenhum passo prepara listas.

## Gates por PR

- `test:franchise`, `test:sync-safety`, `test:health-gate` e `test:deploy`.
- As mutações do PR, cada uma com caso vermelho.
- Deploy só depois do merge, com aprovação do Carlos no environment `production`, e verificação do arquiteto.
- O 2c vai a produção num só deploy no fim, ou em dois se o DBG-16 ficar grande.

## Restrições

- O reset em produção continua vetado (Decisão 35) até o fim do 2c e a verificação do DBG-193 em produção.
- `scripts/catalog/run-approved-sync.js` continua vetado em produção até a verificação em produção e o fecho do DBG-197 (Decisão 43).
- Achados não bloqueantes que ficam como DBG: DBG-194, 195, 196, 198 e 199.
