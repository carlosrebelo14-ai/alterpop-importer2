-- Pauta aduaneira (hs_intrastat_code do feed OcioStock), normalizada para 6 ou 8 dígitos
-- por parseHsCode(). Enviada à Shopify em inventoryItem.harmonizedSystemCode.
-- NULL nos ~9,3% sem valor aproveitável — nesses o campo é omitido, nunca inventado.
ALTER TABLE "CatalogProduct" ADD COLUMN "hsCode" TEXT;
