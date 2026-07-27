-- Barcode (EAN) + timestamp para deduplicação pós-indexação (SQLite-safe)
ALTER TABLE "CatalogProduct" ADD COLUMN "barcode" TEXT;
ALTER TABLE "CatalogProduct" ADD COLUMN "indexedAt" DATETIME;
UPDATE "CatalogProduct" SET "indexedAt" = CURRENT_TIMESTAMP WHERE "indexedAt" IS NULL;

CREATE INDEX "CatalogProduct_shop_barcode_idx" ON "CatalogProduct"("shop", "barcode");
