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

---

## Decisão 24 — crossover multi-valor inalcançável com `resolvedFranchise` escalar

**Data:** 2026-09-12
**Estado:** fechada, sem ação nesta entrega

**Achado:** `resolvedFranchise` é um campo escalar (`String?`) no modelo `CatalogProduct` da Prisma. `alterpop.franchise` é uma lista (`list.single_line_text_field`) no Shopify — a plataforma suporta um produto pertencer a 2+ universos em simultâneo (crossover manual, validado em R1). Mas com a coluna Prisma escalar, nenhum produto pode alguma vez ter 2+ valores resolvidos: o crossover que R1 validou como suportado pela plataforma é **inalcançável pelo modelo de dados atual**.

**Como surgiu:** slot S4 do seletor do lote piloto (Tarefa 41/42, `pilot-batch-select.js`) pedia um SKU com `resolvedFranchise` de 2+ valores para validar crossover por lista. O predicado nunca teve candidatos — não por falta de dados no catálogo, mas porque a coluna não consegue representar essa forma. Ficou documentado no próprio script (comentário no predicado S4) para não voltar a ser testado às cegas.

**Decisão:** sem ação nesta entrega pré-inauguração. Tornar `resolvedFranchise` array exige migração Prisma (mudança de tipo de coluna, não `ADD COLUMN` trivial) e reescrita do `franchiseResolver.server.js` (camadas 1/2 e a escrita em `catalogInsertBatch.server.js`) para produzir e persistir múltiplos valores. Fora do âmbito do portão pré-inauguração — fica registado para uma entrega futura, se o negócio decidir que crossover multi-universo é necessário na prática (hoje é só capacidade teórica da plataforma, sem produto real que precise).

**Referência cruzada:** Tarefa 41, Tarefa 42, `pilot-batch-select.js` (slot S4)
**Sem alteração de código. Sem migração.**

---

## Decisão 25 — classe de risco nova: ref legítimo, licença inexistente

**Data:** 2026-09-12
**Estado:** fechada, sem ação ao resolver antes da inauguração

**Achado:** o feed OcioStock marca produtos com `ref=` de um universo licenciado sem que exista licença real — `franchiseRefs` contém literalmente `"HARRY POTTER"` num produto MGA Entertainment/Miniverse (`0035051531166`, "Miniverse Potion classroom Make It Mini Holiday Harry Potter set"). O atributo descreve tema, não licenciamento. O resolver está correto ao confiar no ref — a falha é a montante, no fornecedor.

A Tarefa 11 (`franchise-title-ref-contradiction.js`) não cobre esta classe: o critério ali é DISCORDÂNCIA entre título e ref, e neste caso título e ref concordam (ambos dizem "Harry Potter") — a concordância é exatamente o que torna o caso invisível a essa auditoria. Foi por isso que o diagnóstico inicial ("camada 2") estava errado — é camada 1 (`resolvedFranchiseLayer: 1`), ref e título ambos corretos tecnicamente, ambos errados comercialmente.

**Decisão:** sem alteração ao `franchiseResolver.server.js` antes da inauguração. Mitigação por curadoria manual do Carlos na seleção final. Censo de refs de licença duvidosa entra na Tarefa 47 (`franchise-brand-overlap-audit.js`, só relatório) — decisão sobre deny-list de marcas genéricas (mga, miniverse, bandai, jada, zuru, clearance) fica para revisão pós-inauguração.

**Referência cruzada:** Tarefa 11, Tarefa 45, Tarefa 47, `franchise-brand-overlap-audit.js`
**Sem alteração de código ao resolver. Sem migração.**
