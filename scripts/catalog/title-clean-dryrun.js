#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 10 — normalização de títulos.
 *
 * DRY-RUN por defeito: imprime uma amostra (200 por omissão), título original vs
 * limpo lado a lado, sem escrever nada.
 *
 * `--execute`: percorre TODO o CatalogProduct por página de cursor (memória
 * constante, máquina Fly 512 MB) e grava `originalTitle` (só se ainda não definido —
 * nunca reescrito) + `cleanTitle` (recalculado sempre). NUNCA toca em `title` nem em
 * `titleOverride` (campo do curador).
 *
 * Os 23 produtos já publicados NÃO são republicados manualmente por este script —
 * entram no reconciliador (Tarefa 6) como qualquer outro produto.
 *
 * Correr na Fly:  node scripts/catalog/title-clean-dryrun.js
 *                 node scripts/catalog/title-clean-dryrun.js --sample 500
 *                 node scripts/catalog/title-clean-dryrun.js --execute
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { cleanProductTitle } from "../../lib/importer/catalog/titleCleaner.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const SAMPLE = parseInt(valOf("--sample", "200"), 10) || 200;
const PAGE = 500;

async function dryRunSample() {
  const rows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP },
    select: { sku: true, title: true, resolvedFranchise: true },
    orderBy: [{ shop: "asc" }, { sku: "asc" }],
    take: SAMPLE,
  });

  let changed = 0;
  console.log(`\n=== title-clean-dryrun (${SHOP}) · DRY-RUN · amostra ${rows.length} ===\n`);
  for (const r of rows) {
    const clean = cleanProductTitle({ title: r.title, resolvedFranchise: r.resolvedFranchise });
    if (clean !== r.title) {
      changed += 1;
      console.log(`  ${r.sku}`);
      console.log(`    antes : "${r.title}"`);
      console.log(`    depois: "${clean}"`);
    }
  }
  console.log(`\nmudaram: ${changed}/${rows.length} (${((changed / rows.length) * 100).toFixed(1)}%)`);
  console.log(`\n(nada escrito — dry-run. Para gravar originalTitle/cleanTitle em todo o catálogo: --execute)`);
}

async function execute() {
  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== title-clean-dryrun (${SHOP}) · --execute · CatalogProduct: ${total} ===\n`);

  let processed = 0;
  let changed = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, resolvedFranchise: true, originalTitle: true, cleanTitle: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    const updates = [];
    for (const r of rows) {
      const clean = cleanProductTitle({ title: r.title, resolvedFranchise: r.resolvedFranchise });
      const data = {};
      if (r.originalTitle == null) data.originalTitle = r.title;
      if (r.cleanTitle !== clean) data.cleanTitle = clean;
      if (clean !== r.title) changed += 1;
      if (Object.keys(data).length) {
        updates.push(
          prisma.catalogProduct.update({ where: { shop_sku: { shop: SHOP, sku: r.sku } }, data })
        );
      }
    }
    if (updates.length) await prisma.$transaction(updates);

    processed += rows.length;
    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (processed % 5000 === 0 || rows.length < PAGE) console.log(`  ${processed}/${total}…`);
    if (rows.length < PAGE) break;
  }

  console.log(`\nprocessados: ${processed}  ·  cleanTitle ≠ title: ${changed}`);
}

async function main() {
  if (EXECUTE) await execute();
  else await dryRunSample();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
