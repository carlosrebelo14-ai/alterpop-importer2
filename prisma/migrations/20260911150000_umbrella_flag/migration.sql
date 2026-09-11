-- Decisão 9 / Tarefa 14b (2026-09-11) — flag UMBRELLA.
--
-- true quando resolvedFranchise veio da camada 3 "chapéu" (Disney/Marvel), não de um
-- universo próprio. Coluna existe já; permanece false em todo o catálogo até a camada
-- de chapéu ser ligada de facto a resolveFranchise() (Decisão 9, condições 1-4).

ALTER TABLE "CatalogProduct" ADD COLUMN "resolvedUmbrella" BOOLEAN NOT NULL DEFAULT false;
