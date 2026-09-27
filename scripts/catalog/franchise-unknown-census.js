#!/usr/bin/env node
/**
 * Só leitura — briefing 27/09, N2 (medição). Valores de resolvedFranchise no catálogo
 * Prisma (CatalogProduct) que não existem em FRANCHISE_UNIVERSES, com contagem por
 * valor e até 10 títulos de amostra por valor. Mesma comparação que FRANCHISE_UNKNOWN
 * (findUnknownFranchiseValues — igualdade exata NFC, tabela inteira open+closed).
 *
 * O lado da loja live é o live-publish-audit.js (FRANCHISE_UNKNOWN, source "live").
 *
 * Não escreve nada.
 *
 *   flyctl ssh console -a alterpop-importer-app \
 *     -C "node scripts/catalog/franchise-unknown-census.js"
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { findUnknownFranchiseValues } from "../../lib/importer/curation/prePublishChecks.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const SAMPLES = 10;

async function main() {
  console.log(`=== franchise-unknown-census (${SHOP}) · só leitura ===`);

  const groups = await prisma.catalogProduct.groupBy({
    by: ["resolvedFranchise"],
    where: { shop: SHOP },
    _count: { _all: true },
  });

  const total = groups.reduce((n, g) => n + g._count._all, 0);
  const empty = groups.filter((g) => g.resolvedFranchise == null || g.resolvedFranchise === "");
  const unknown = groups
    .filter((g) => g.resolvedFranchise && findUnknownFranchiseValues(g.resolvedFranchise).length)
    .sort((a, b) => b._count._all - a._count._all);
  const canonical = groups.filter(
    (g) => g.resolvedFranchise && !findUnknownFranchiseValues(g.resolvedFranchise).length,
  );

  const sum = (list) => list.reduce((n, g) => n + g._count._all, 0);
  console.log(`\nlinhas CatalogProduct: ${total}`);
  console.log(`  com valor canónico: ${sum(canonical)} (${canonical.length} universos)`);
  console.log(`  sem valor (MISSING_FRANCHISE): ${sum(empty)}`);
  console.log(`  FORA DA TABELA (FRANCHISE_UNKNOWN): ${sum(unknown)} em ${unknown.length} valor(es)`);

  for (const g of unknown) {
    const v = g.resolvedFranchise;
    const nfcHint = v.normalize("NFC") !== v ? " [não-NFC]" : "";
    console.log(`\n── ${JSON.stringify(v)}${nfcHint} — ${g._count._all} ──`);
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP, resolvedFranchise: v },
      select: { sku: true, title: true },
      take: SAMPLES,
      orderBy: { sku: "asc" },
    });
    for (const r of rows) console.log(`  ${r.sku}  ${r.title}`);
  }

  const counted = sum(canonical) + sum(empty) + sum(unknown);
  console.log(`\n[franchise-unknown-census] DONE. processed=${counted} total=${total}`);
  if (counted !== total) {
    console.error(`[franchise-unknown-census] FATAL: processed (${counted}) != total (${total})`);
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
