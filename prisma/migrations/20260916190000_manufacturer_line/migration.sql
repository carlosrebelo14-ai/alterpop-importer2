-- B6 (briefing backend, 16/09/2026) — manufacturerLineExtractor.server.js.
-- Coluna nullable pura (sem @default) — ADD COLUMN sem risco de perda de dados,
-- mesmo padrão seguro da migração resolvedFormat (20260911180000).
-- Aplicar com: npm run db:push (passo de deploy manual, Tarefa 28 / Decisão 13).

ALTER TABLE "CatalogProduct" ADD COLUMN "resolvedManufacturerLine" TEXT;
