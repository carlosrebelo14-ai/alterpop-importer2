# Registo de decisões — normalização de franquias

Uma entrada por decisão fechada pelo Carlos. Emendas ficam no bloco da decisão original, nunca reescrevem o texto fechado — o histórico conta.

---

## Decisão 17 — limiar de 3% na regra prefixo-formato

**Data:** 2026-09-11
**Estado:** fechada, **emendada pela Decisão 21** (ver abaixo)

`FORMAT_PREFIXES` reduzido a `Assorted` e `Latino` (Tarefa 32) — o censo da Tarefa 31 mostrou que "POP figure" sozinho era 79% das remoções, informação de formato genuína, não ruído a limpar do título. Reteste dos 5 casos obrigatórios + nova taxa global sobre o catálogo completo antes de qualquer `--execute`.

> ⚠️ **Ver Decisão 21** — a leitura original do "3%" como teto rígido foi corrigida. Não citar este limiar sem o ponteiro abaixo.

### Emenda — Decisão 21 (2026-09-12)

**Contexto do averbamento:** a Decisão 17 fixou um limiar de 3% sobre a taxa de alteração de títulos pela regra prefixo-formato. O limiar foi lido como teto rígido. A intenção real era portão de auto-aprovação. A corrida da Tarefa 33 mediu 3,4% exatos sobre o catálogo completo e foi aprovada nominalmente, o que expôs a ambiguidade.

**Texto normativo:**

> **Decisão 21 — Emenda à Decisão 17**
>
> O valor de 3% da Decisão 17 é portão de auto-aprovação, não teto rígido.
>
> Taxa ≤3% — o `--execute` do backfill de títulos corre sem aprovação adicional.
>
> Taxa >3% — o `--execute` exige aprovação nominal do Carlos por corrida, com o censo de prefixos removidos anexado ao pedido.
>
> A taxa medida na Tarefa 33 foi de 3,4% (854 de 25 420, contagem exata sobre o catálogo completo, sem amostragem). Excedeu o portão, teve aprovação nominal e foi executada. O backfill não é revertido.
>
> Esta regra aplica-se a qualquer `--execute` futuro do `title-clean` e a qualquer script de backfill em massa que altere campos de catálogo já resolvidos.

**Estado:** fechada
**Referência cruzada:** Decisão 17, Tarefa 32, Tarefa 33
**Sem alteração de código. Sem migração.**
