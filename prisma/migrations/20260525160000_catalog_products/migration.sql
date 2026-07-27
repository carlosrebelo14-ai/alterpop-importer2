-- CreateTable
CREATE TABLE "CatalogProduct" (
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "categoryMain" TEXT,
    "categorySegments" TEXT NOT NULL DEFAULT '[]',
    "vendor" TEXT,
    "vendorNorm" TEXT NOT NULL DEFAULT '',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "franchises" TEXT NOT NULL DEFAULT '[]',

    PRIMARY KEY ("shop", "sku")
);

-- CreateTable
CREATE TABLE "CatalogProductFilterTag" (
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "filterId" TEXT NOT NULL,

    PRIMARY KEY ("shop", "sku", "filterId")
);

-- CreateIndex
CREATE INDEX "CatalogProduct_shop_vendorNorm_idx" ON "CatalogProduct"("shop", "vendorNorm");

-- CreateIndex
CREATE INDEX "CatalogProduct_shop_categoryMain_idx" ON "CatalogProduct"("shop", "categoryMain");

-- CreateIndex
CREATE INDEX "CatalogProductFilterTag_shop_filterId_idx" ON "CatalogProductFilterTag"("shop", "filterId");

-- CreateIndex
CREATE INDEX "CatalogProductFilterTag_shop_sku_idx" ON "CatalogProductFilterTag"("shop", "sku");
