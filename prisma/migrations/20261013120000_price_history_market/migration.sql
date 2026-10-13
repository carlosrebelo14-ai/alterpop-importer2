-- Decisão 31 (briefing "Preço sem IVA e guarda do tema"): histórico de preços enviados à
-- Shopify (com a regra de cálculo) e observações manuais de preço de mercado.
-- Ver comentários em schema.prisma (PriceHistory, MarketPriceObservation).
-- Tabelas novas, aditivas (sem colunas novas em CatalogProduct, sem DROP).
-- Aplicar com: npm run db:push (passo de deploy manual, depois de `fly deploy`).
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "rule" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "at" DATETIME NOT NULL
);

CREATE INDEX "PriceHistory_shop_sku_at_idx" ON "PriceHistory"("shop", "sku", "at");

CREATE TABLE "MarketPriceObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "store" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "MarketPriceObservation_shop_sku_observedAt_idx" ON "MarketPriceObservation"("shop", "sku", "observedAt");
