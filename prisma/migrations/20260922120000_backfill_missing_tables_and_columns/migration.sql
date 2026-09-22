-- Backfill de histórico de migrações (auditoria 2026-09-22) — 5 mudanças de schema
-- existiam em schema.prisma mas nunca tinham ficheiro de migração: OrderStockAlert,
-- MarketSettings, SavedFilterSet, SyncJob (tabelas novas, sem risco de perda de
-- dados) e CatalogProduct.resolvedCharacters (coluna nullable pura, mesmo padrão
-- seguro de resolvedFormat/resolvedManufacturerLine/lastPublishedTitle). Confirmado
-- por "prisma migrate diff" contra uma base de dados limpa com todas as migrações
-- anteriores aplicadas — estas eram as únicas 5 diferenças entre o histórico de
-- migrações e schema.prisma. Sem esta migração, "prisma migrate deploy" numa base
-- de dados nova nunca criava estas tabelas/coluna, e todo o código que as usa
-- (catalogInsertBatch.server.js, app.settings.jsx, api.saved-filters.jsx,
-- api.order-stock-alerts.jsx, webhooks.orders.create.jsx, shopifySyncJob.server.js)
-- falhava em silêncio (safePrisma engole "no such table"/"no such column").

-- CreateTable
CREATE TABLE "OrderStockAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "orderedQty" INTEGER NOT NULL,
    "indexedStock" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE INDEX "OrderStockAlert_shop_resolved_idx" ON "OrderStockAlert"("shop", "resolved");

-- CreateIndex
CREATE INDEX "OrderStockAlert_shop_orderId_idx" ON "OrderStockAlert"("shop", "orderId");

-- CreateTable
CREATE TABLE "MarketSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "vipBrands" TEXT NOT NULL DEFAULT '[]',
    "vipLicences" TEXT NOT NULL DEFAULT '[]',
    "vipCategories" TEXT NOT NULL DEFAULT '[]',
    "blockedTerms" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SavedFilterSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filtersJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SavedFilterSet_shop_idx" ON "SavedFilterSet"("shop");

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "received" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running'
);

-- CreateIndex
CREATE INDEX "SyncJob_shop_startedAt_idx" ON "SyncJob"("shop", "startedAt");

-- AlterTable (coluna nullable pura — ver comentário em schema.prisma sobre resolvedCharacters)
ALTER TABLE "CatalogProduct" ADD COLUMN "resolvedCharacters" TEXT;
