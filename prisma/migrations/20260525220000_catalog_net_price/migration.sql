-- AlterTable
ALTER TABLE "CatalogProduct" ADD COLUMN "netPrice" REAL;
ALTER TABLE "CatalogProduct" ADD COLUMN "grossPrice" REAL;

-- CreateIndex
CREATE INDEX "CatalogProduct_shop_netPrice_idx" ON "CatalogProduct"("shop", "netPrice");
