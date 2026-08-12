-- Item 5 do pacote de melhorias criativas de 2026-08-12 — coleções automáticas por
-- licença. Ver comentário em schema.prisma (AutoCollectionLicence).
CREATE TABLE "AutoCollectionLicence" (
    "shop" TEXT NOT NULL,
    "licenceKey" TEXT NOT NULL,
    "licenceLabel" TEXT NOT NULL,
    "shopifyCollectionId" TEXT NOT NULL,
    "productCountAtCreate" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("shop", "licenceKey")
);
