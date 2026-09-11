-- BRIEFING BACKEND (2026-09-11) — Tarefa 10, normalização de títulos.
--
-- originalTitle: cópia do `title` bruto no momento em que o limpador correu pela
--   primeira vez. Nunca reescrito depois.
-- cleanTitle: `title` depois do limpador (titleCleaner.server.js) — prefixos de
--   fornecedor, preço/moeda, franquia duplicada, espaços. NULL até correr
--   scripts/catalog/title-clean-dryrun.js --execute.
-- titleOverride: só escrito à mão pelo curador. Nunca tocado pelo indexador.
--
-- Publisher (shopifyMapper.server.js) passa a enviar titleOverride ?? cleanTitle ?? title.

ALTER TABLE "CatalogProduct" ADD COLUMN "originalTitle" TEXT;
ALTER TABLE "CatalogProduct" ADD COLUMN "cleanTitle" TEXT;
ALTER TABLE "CatalogProduct" ADD COLUMN "titleOverride" TEXT;
