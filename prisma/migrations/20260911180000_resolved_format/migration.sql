-- Tarefa 34 (Decisão 18, 2026-09-11) — formatExtractor.server.js.
-- Coluna nullable pura (sem @default) — ADD COLUMN sem risco de perda de dados,
-- ao contrário do incidente da Tarefa 27 com resolvedUmbrella.
-- Aplicar com: npm run db:push (passo de deploy manual, Tarefa 28 / Decisão 13).

ALTER TABLE "CatalogProduct" ADD COLUMN "resolvedFormat" TEXT;
