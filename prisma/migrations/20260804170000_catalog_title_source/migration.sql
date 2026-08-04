-- Origem do título indexado (Opção C, 2026-08-04).
--   "supplier" = veio já em inglês da coluna xml_info_otros_idiomas do fornecedor e
--                NÃO deve ser re-traduzido na leitura nem no publish
--   "pipeline" = passou pelo glossário + API (comportamento anterior)
--   NULL       = linha indexada antes desta mudança; tratada como "pipeline"
ALTER TABLE "CatalogProduct" ADD COLUMN "titleSource" TEXT;
