-- ENTREGA 2 (2026-09-10) — Lines dentro de universos.
--
-- resolvedLine: nome canónico da Line resolvida pelo franchiseResolver (tabela em
--   franchiseLines.js), ou NULL. Ex.: "The Mandalorian" dentro do universo "Star Wars".
--   O universo continua em resolvedFranchise (o parent ganha o slot); resolvedLine é
--   classificação adicional. Alimenta o metafield alterpop.line e a coleção Line.
--
-- Preenchido na re-resolução da Prisma (scripts/catalog/franchise-reresolve-db.js) e,
-- daí em diante, em cada indexação.

ALTER TABLE "CatalogProduct" ADD COLUMN "resolvedLine" TEXT;

CREATE INDEX "CatalogProduct_shop_resolvedLine_idx" ON "CatalogProduct"("shop", "resolvedLine");
