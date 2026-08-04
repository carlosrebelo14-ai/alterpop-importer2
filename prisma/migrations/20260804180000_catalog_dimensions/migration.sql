-- Dimensões da embalagem, já formatadas em cm ("25 × 5 × 15 cm"), vindas de
-- xml_info_dimensiones (formato <size unit="mm"><width/><height/><depth/></size>).
-- Guardadas como texto porque só são usadas para exibição (tabela de especificações
-- + metafield custom.dimensions) — três colunas numéricas não trariam nada.
-- NULL nos ~31% de produtos sem esse dado no feed do fornecedor.
ALTER TABLE "CatalogProduct" ADD COLUMN "dimensions" TEXT;
