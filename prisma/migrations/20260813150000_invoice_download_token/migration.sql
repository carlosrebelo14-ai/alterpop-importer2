-- Conta de cliente: link de fatura autenticado (Customer Account UI Extension "order-invoice").
-- Ver comentário em schema.prisma (InvoiceDownloadToken).
CREATE TABLE "InvoiceDownloadToken" (
    "token" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderSnapshotJson" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "InvoiceDownloadToken_shop_orderId_idx" ON "InvoiceDownloadToken"("shop", "orderId");
