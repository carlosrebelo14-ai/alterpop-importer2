#!/usr/bin/env node
/**
 * B6 (briefing backend, 16/09/2026) — extrator de manufacturer_line, dry-run.
 *
 * DRY-RUN por defeito: distribuição por valor de linha sobre TODO o catálogo (contagem
 * + % + amostra), sem escrever nada. Mesmo padrão do format-extract-dryrun.js
 * (Tarefa 34/Decisão 18) — ver esta distribuição antes de qualquer --execute.
 *
 * `--execute`: grava `resolvedManufacturerLine` em todo o catálogo por página de
 * cursor (memória constante). NUNCA toca em title/cleanTitle/titleOverride/vendor.
 *
 * Correr na Fly:  node scripts/catalog/manufacturer-line-extract-dryrun.js
 *                 node scripts/catalog/manufacturer-line-extract-dryrun.js --execute
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { extractManufacturerLine, MANUFACTURER_LINE_VALUES } from "../../lib/importer/catalog/manufacturerLineExtractor.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const PAGE = 500;

async function dryRunDistribution() {
  console.log(`\n=== manufacturer-line-extract-dryrun (${SHOP}) · DRY-RUN — distribuição ===\n`);

  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  const counts = new Map(MANUFACTURER_LINE_VALUES.map((f) => [f, { count: 0, samples: [] }]));
  counts.set(null, { count: 0, samples: [] });
  let cursor = null;
  let scanned = 0;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, vendor: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      scanned += 1;
      const line = extractManufacturerLine({ vendor: r.vendor, title: r.title });
      const entry = counts.get(line);
      entry.count += 1;
      if (entry.samples.length < 5) entry.samples.push({ sku: r.sku, title: r.title, vendor: r.vendor });
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  // P1 (ADENDA 3, 17/09/2026) — mesma verificação aplicada ao backfill de formato/
  // título: o catálogo tem escrita concorrente, uma página curta pode ser "a tabela
  // encolheu a meio", não "chegámos ao fim". Falha alto em vez de reportar incompleto.
  const totalAtEnd = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  if (scanned !== totalAtEnd) {
    throw new Error(
      `paginação incompleta: analisados=${scanned}, catálogo agora=${totalAtEnd} (era ${total} ao início) — corre outra vez`
    );
  }

  console.log(`produtos analisados: ${scanned} (catálogo: ${total})\n`);
  console.log(`  ${"contagem".padStart(8)}  ${"%".padStart(6)}  linha`);
  const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [line, entry] of sorted) {
    if (!entry.count) continue;
    console.log(`  ${String(entry.count).padStart(8)}  ${((entry.count / scanned) * 100).toFixed(2).padStart(6)}  ${line ?? "∅ (sem linha)"}`);
  }
  const noneEntry = counts.get(null);
  console.log(`  ${String(noneEntry.count).padStart(8)}  ${((noneEntry.count / scanned) * 100).toFixed(2).padStart(6)}  ∅ (sem linha / fabricante fora do mapa)`);

  console.log(`\n── amostra por valor (fabricante) ──`);
  for (const [line, entry] of sorted) {
    if (!entry.count) continue;
    console.log(`\n  ${line} (${entry.count}):`);
    entry.samples.forEach((s) => console.log(`    ${s.sku}  [${s.vendor}]  "${s.title}"`));
  }

  console.log(`\n(nada escrito — dry-run.)`);
}

async function execute() {
  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== manufacturer-line-extract-dryrun (${SHOP}) · --execute · CatalogProduct: ${total} ===\n`);

  let processed = 0;
  let changed = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, vendor: true, resolvedManufacturerLine: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    const updates = [];
    for (const r of rows) {
      const line = extractManufacturerLine({ vendor: r.vendor, title: r.title });
      if (r.resolvedManufacturerLine !== line) {
        changed += 1;
        updates.push(
          prisma.catalogProduct.update({ where: { shop_sku: { shop: SHOP, sku: r.sku } }, data: { resolvedManufacturerLine: line } })
        );
      }
    }
    if (updates.length) await prisma.$transaction(updates);

    processed += rows.length;
    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (processed % 5000 === 0 || rows.length < PAGE) console.log(`  ${processed}/${total}…`);
    if (rows.length < PAGE) break;
  }

  const totalAtEnd = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  if (processed !== totalAtEnd) {
    throw new Error(
      `paginação incompleta: processados=${processed}, catálogo agora=${totalAtEnd} (era ${total} ao início) — corre outra vez`
    );
  }

  console.log(`\nprocessados: ${processed}  ·  resolvedManufacturerLine alterado: ${changed}`);
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
