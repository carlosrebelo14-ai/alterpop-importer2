-- Briefing de preço (07/10/2026) — precio_distribuidores do feed, custo sem IVA.
-- Coluna nullable pura (sem @default) — ADD COLUMN sem risco de perda de dados,
-- mesmo padrão seguro de lastPublishedTitle (20260917120000). Aplicar com:
-- npm run db:push (passo de deploy manual, Decisão 13). Fica NULL até o próximo
-- reindex do feed preencher.

ALTER TABLE "CatalogProduct" ADD COLUMN "distributorPrice" REAL;
