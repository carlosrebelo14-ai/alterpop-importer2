-- CreateTable
CREATE TABLE "MarketSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "vipBrands" TEXT NOT NULL DEFAULT '[]',
    "vipLicences" TEXT NOT NULL DEFAULT '[]',
    "vipCategories" TEXT NOT NULL DEFAULT '[]',
    "blockedTerms" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CatalogProduct" (
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "categoryMain" TEXT,
    "categorySegments" TEXT NOT NULL DEFAULT '[]',
    "vendor" TEXT,
    "vendorNorm" TEXT NOT NULL DEFAULT '',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "franchises" TEXT NOT NULL DEFAULT '[]',
    "netPrice" REAL,
    "grossPrice" REAL,
    "imageUrl" TEXT,
    "barcode" TEXT,
    "indexedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("shop", "sku")
);
INSERT INTO "new_CatalogProduct" ("barcode", "categoryMain", "categorySegments", "franchises", "grossPrice", "imageUrl", "indexedAt", "netPrice", "shop", "sku", "stock", "title", "vendor", "vendorNorm") SELECT "barcode", "categoryMain", "categorySegments", "franchises", "grossPrice", "imageUrl", coalesce("indexedAt", CURRENT_TIMESTAMP) AS "indexedAt", "netPrice", "shop", "sku", "stock", "title", "vendor", "vendorNorm" FROM "CatalogProduct";
DROP TABLE "CatalogProduct";
ALTER TABLE "new_CatalogProduct" RENAME TO "CatalogProduct";
CREATE INDEX "CatalogProduct_shop_vendorNorm_idx" ON "CatalogProduct"("shop", "vendorNorm");
CREATE INDEX "CatalogProduct_shop_categoryMain_idx" ON "CatalogProduct"("shop", "categoryMain");
CREATE INDEX "CatalogProduct_shop_netPrice_idx" ON "CatalogProduct"("shop", "netPrice");
CREATE INDEX "CatalogProduct_shop_barcode_idx" ON "CatalogProduct"("shop", "barcode");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
