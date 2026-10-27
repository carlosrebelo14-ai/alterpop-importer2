# Definição do metaobject `character` (contrato)

Decisão do arquiteto, 27/10/2026. Opção 1 do passo D.

## Estado atual

Campo `products` (`list.product_reference`):

- `required`: **false** (era true)
- validações: `list.max` = 128. A validação `list.min` = 1 foi removida.

Os restantes campos não mudaram: `title` obrigatório, `image` opcional, `universe` obrigatório com `list.min` = 1.

## Motivo

Com o limiar de Character ACTIVE em 1 (I2), um personagem sem produto publicado tem de existir em DRAFT com `products` vazio. Com o campo obrigatório, a Shopify recusava esse estado (`Produtos não pode estar em branco`). Apagar os metaobjects mudava os GIDs, e aceitar I2 vermelho mantinha páginas vazias públicas (P3 do briefing).

## Reversão

A definição anterior completa está em `docs/contrato/character-definition-2026-10-27-antes.json`. Para reverter, pôr `required: true` em `products` e a validação `list.min` = 1, por `metaobjectDefinitionUpdate`. Antes de reverter, confirmar que nenhum character DRAFT ficou com `products` vazio, porque a Shopify volta a recusar esse estado.

## Efeito no código

- `lib/importer/shopify/characterPagesSync.server.js`: `set-draft` envia só `capabilities.publishable.status = DRAFT`. Deixa de existir o caminho `undraftable`. Qualquer erro do upsert aborta.
- `scripts/tests/character-pages-draft-vazio.test.js`: prova que um character com 0 produtos passa a DRAFT sem erro.
