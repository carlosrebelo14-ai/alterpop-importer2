-- Normalização de franquias, Fase 4.
--
-- franchiseRefs: só os atributos ref="..." de xml_info_familias, separados dos tokens de
--   categoria (parseFamilySignals). Não passam por tradução. Chave da camada 1 do
--   franchiseResolver. Default "[]"; preenchido na próxima indexação completa.
-- resolvedFranchise: nome canónico do universo (tabela dos 41 em franchiseUniverses.js)
--   atribuído pelo resolver, ou NULL. resolvedFranchiseLayer: 1 = por ref, 2 = por título.
--
-- Não escreve metafields nem coleções Shopify — isso é Fases 5-8.

ALTER TABLE "CatalogProduct" ADD COLUMN "franchiseRefs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "CatalogProduct" ADD COLUMN "resolvedFranchise" TEXT;
ALTER TABLE "CatalogProduct" ADD COLUMN "resolvedFranchiseLayer" INTEGER;

CREATE INDEX "CatalogProduct_shop_resolvedFranchise_idx" ON "CatalogProduct"("shop", "resolvedFranchise");
