-- B18 item 5 (briefing backend, 17/09/2026) — live-title-reconcile.js.
-- Coluna nullable pura (sem @default) — ADD COLUMN sem risco de perda de dados,
-- mesmo padrão seguro de resolvedFormat (20260911180000) / resolvedManufacturerLine
-- (20260916190000). Aplicar com: npm run db:push (passo de deploy manual, Decisão 13).

ALTER TABLE "CatalogProduct" ADD COLUMN "lastPublishedTitle" TEXT;
