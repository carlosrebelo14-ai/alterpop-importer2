-- Peso real do fornecedor (xml_info_peso), para envio correto de weight à Shopify
ALTER TABLE "CatalogProduct" ADD COLUMN "weightKg" REAL;
