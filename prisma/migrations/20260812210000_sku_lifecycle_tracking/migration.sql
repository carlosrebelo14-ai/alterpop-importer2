-- Item 2/3 do pacote de melhorias criativas de 2026-08-12 — deteção de novidades e
-- descontinuados do fornecedor. Ver comentário em schema.prisma (CatalogSkuTracking).
CREATE TABLE "CatalogSkuTracking" (
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "vendor" TEXT,
    "franchises" TEXT NOT NULL DEFAULT '[]',
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missingCycles" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',

    PRIMARY KEY ("shop", "sku")
);

CREATE INDEX "CatalogSkuTracking_shop_status_idx" ON "CatalogSkuTracking"("shop", "status");
CREATE INDEX "CatalogSkuTracking_shop_lastSeenAt_idx" ON "CatalogSkuTracking"("shop", "lastSeenAt");

CREATE TABLE "SkuLifecycleCycleReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "ranAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "newSkuCount" INTEGER NOT NULL DEFAULT 0,
    "newVipSkusJson" TEXT NOT NULL DEFAULT '[]',
    "discontinuedReviewCount" INTEGER NOT NULL DEFAULT 0,
    "discontinuedReviewJson" TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX "SkuLifecycleCycleReport_shop_ranAt_idx" ON "SkuLifecycleCycleReport"("shop", "ranAt");
