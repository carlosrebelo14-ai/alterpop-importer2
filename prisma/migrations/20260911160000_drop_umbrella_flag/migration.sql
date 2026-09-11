-- Tarefa 27 (2026-09-11) — arquiva a camada de chapéu. Nunca foi ligada a
-- resolveFranchise()/indexação/publisher (permaneceu default false em todo o
-- catálogo), por isso não há dados a migrar — só a coluna sai.

ALTER TABLE "CatalogProduct" DROP COLUMN "resolvedUmbrella";
