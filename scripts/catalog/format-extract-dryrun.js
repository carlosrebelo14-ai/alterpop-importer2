#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 34 (Decisão 18) — extrator de formato, dry-run.
 *
 * DRY-RUN por defeito: distribuição por valor de formato sobre TODO o catálogo
 * (contagem + % + amostra), sem escrever nada. Decisão 18 exige ver esta distribuição
 * antes de qualquer --execute — sem aprovação prévia, ao contrário da Tarefa 10/33.
 *
 * `--execute`: grava `resolvedFormat` em todo o catálogo por página de cursor (memória
 * constante). NUNCA toca em `title`/`cleanTitle`/`titleOverride`.
 *
 * Correr na Fly:  node scripts/catalog/format-extract-dryrun.js
 *                 node scripts/catalog/format-extract-dryrun.js --execute
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { extractProductFormat, FORMAT_VALUES } from "../../lib/importer/catalog/formatExtractor.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const PAGE = 500;

async function dryRunDistribution() {
  console.log(`\n=== format-extract-dryrun (${SHOP}) · DRY-RUN — distribuição ===\n`);

  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  const counts = new Map(FORMAT_VALUES.map((f) => [f, { count: 0, samples: [] }]));
  counts.set(null, { count: 0, samples: [] });
  let cursor = null;
  let scanned = 0;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      scanned += 1;
      const format = extractProductFormat({ title: r.title });
      const entry = counts.get(format);
      entry.count += 1;
      if (entry.samples.length < 5) entry.samples.push({ sku: r.sku, title: r.title });
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`produtos analisados: ${scanned} (catálogo: ${total})\n`);
  console.log(`  ${"contagem".padStart(8)}  ${"%".padStart(6)}  formato`);
  const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [format, entry] of sorted) {
    console.log(`  ${String(entry.count).padStart(8)}  ${((entry.count / scanned) * 100).toFixed(2).padStart(6)}  ${format ?? "∅ (sem formato)"}`);
  }

  console.log(`\n── amostra por valor ──`);
  for (const [format, entry] of sorted) {
    if (!entry.count) continue;
    console.log(`\n  ${format ?? "∅"} (${entry.count}):`);
    entry.samples.forEach((s) => console.log(`    ${s.sku}  "${s.title}"`));
  }

  console.log(`\n(nada escrito — dry-run. Sem aprovação prévia para --execute nesta tarefa.)`);
}

async function execute() {
  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== format-extract-dryrun (${SHOP}) · --execute · CatalogProduct: ${total} ===\n`);

  let processed = 0;
  let changed = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, resolvedFormat: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    const updates = [];
    for (const r of rows) {
      const format = extractProductFormat({ title: r.title });
      if (r.resolvedFormat !== format) {
        changed += 1;
        updates.push(
          prisma.catalogProduct.update({ where: { shop_sku: { shop: SHOP, sku: r.sku } }, data: { resolvedFormat: format } })
        );
      }
    }
    if (updates.length) await prisma.$transaction(updates);

    processed += rows.length;
    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (processed % 5000 === 0 || rows.length < PAGE) console.log(`  ${processed}/${total}…`);
    if (rows.length < PAGE) break;
  }

  console.log(`\nprocessados: ${processed}  ·  resolvedFormat alterado: ${changed}`);
}

async function main() {
  if (EXECUTE) await execute();
  else await dryRunDistribution();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
