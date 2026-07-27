-- CreateTable
CREATE TABLE "SyncErrorLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "errorType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "jobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProductSalesSnapshot" (
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "unitsSold30d" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("shop", "sku")
);

-- CreateIndex
CREATE INDEX "SyncErrorLog_shop_createdAt_idx" ON "SyncErrorLog"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "SyncErrorLog_shop_sku_idx" ON "SyncErrorLog"("shop", "sku");

-- CreateIndex
CREATE INDEX "ProductSalesSnapshot_shop_unitsSold30d_idx" ON "ProductSalesSnapshot"("shop", "unitsSold30d");
