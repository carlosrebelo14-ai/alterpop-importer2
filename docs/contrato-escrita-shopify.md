# Contrato de escrita na loja — productUpdate e productSet

Decisão do arquiteto, 27/10/2026 (PR 4, pipeline de Characters).

## Regra

- O pipeline de Characters (`characterPagesSync`, o ciclo de Characters e o reconciliador
  dos passos 7 e 8) escreve só com `metafieldsSet`, mutações de metaobject e
  `publishablePublish` / `publishableUnpublish`.
- `productSet` fica permitido só na criação de produto novo.
- `productUpdate` e `productSet` sobre produto existente ficam proibidos no pipeline de
  Characters.
- Fora desse pipeline, as chamadas listadas abaixo são exceções documentadas. Nenhuma
  chamada nova entra sem atualizar este ficheiro. `scripts/tests/shopify-write-contract.test.js`
  falha se aparecer um ficheiro fora da lista.

## Exceções vivas

| Ficheiro | Linhas | Mutação | Motivo |
|---|---|---|---|
| `lib/importer/shopify/shopifyProductPublisher.server.js` | 98–100, 445, 492, 519 | `productUpdate` | Sync de produto existente (`updateExistingProduct`) e passagem a DRAFT quando o preço falha |
| `lib/importer/importers/ProductImporter.js` | 60–62, 411, 614, 740, 797, 829 | `productUpdate` | Importador: atualização de produto existente, estado após criação, passagem a DRAFT quando o preço falha, e `simulateDryRunUpsert` |
| `lib/importer/shopify/despublicacao.server.js` | 9, 23 | `productUpdate` com `{ id, status: "DRAFT" }` | Decisão 44, ponto 6 (emenda ao briefing de 17/09, :24) |
| `scripts/catalog/vendor-backfill.js` | 56, 158 | `productUpdate` (vendor, descrição) | Backfill de vendor. Não corre no PR 4 |
| `scripts/catalog/live-title-reconcile.js` | 72, 201 | `productUpdate` (só `title`) | Reconciliação de título, por desenho |
| `scripts/maintenance/backfill-product-descriptions-b15.mjs` | 34–36, 86 | `productUpdate` (descrição) | Ferramenta de manutenção existente. **Não constava da lista do arquiteto de 27/10. Incluída para o teste passar; a confirmar.** |
| `scripts/maintenance/fix-license-universe-links.mjs` | 37–39, 72 | `productUpdate` (descrição) | Ferramenta de manutenção existente. **Não constava da lista do arquiteto de 27/10. Incluída para o teste passar; a confirmar.** |

## Sem chamada própria

- `lib/importer/catalog/brandDisplayNames.js` (:138) só menciona `productUpdate` num comentário.
  O caminho real é `scripts/catalog/vendor-backfill.js`.

## Estado de `productSet`

- Nenhum `productSet` no código em 27/10.
- O passo 5 do pipeline (um `productSet` na criação) não entra no PR 4. A criação continua em
  `productCreate`. A ligação de personagem chega por `metafieldsSet` no passo 3 e no ciclo,
  para todo o produto publicado.
