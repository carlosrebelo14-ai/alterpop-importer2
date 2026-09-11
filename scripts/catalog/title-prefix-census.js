#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 31 — lista de prefixos distintos com contagem, ordenada.
 * Bloqueia o `--execute` da Tarefa 10 (Decisão 16).
 *
 * SÓ RELATÓRIO. Quebra o agregado da Tarefa 19 (21,46% do catálogo, regra
 * prefixo-formato) por CADA entrada de FORMAT_PREFIXES — quantos produtos cada uma
 * apanha, para ver se alguma domina desproporcionalmente ou se alguma nunca dispara
 * (candidata a lixo morto na lista).
 *
 * Correr na Fly:  node scripts/catalog/title-prefix-census.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { matchFormatPrefix } from "../../lib/importer/catalog/franchiseResolver.server.js";

const SHOP =
  (process.argv.indexOf("--shop") >= 0 && process.argv[process.argv.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const PAGE = 500;

async function main() {
  console.log(`\n=== title-prefix-census (${SHOP}) — Tarefa 31 (Decisão 16) ===\n`);

  const counts = new Map(); // prefixo -> { count, samples: [title] }
  let scanned = 0;
  let matched = 0;
  let cursor = null;

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
      const prefix = matchFormatPrefix(r.title);
      if (!prefix) continue;
      matched += 1;
      let entry = counts.get(prefix);
      if (!entry) {
        entry = { count: 0, samples: [] };
        counts.set(prefix, entry);
      }
      entry.count += 1;
      if (entry.samples.length < 3) entry.samples.push({ sku: r.sku, title: r.title });
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);

  console.log(`produtos analisados: ${scanned}`);
  console.log(`com prefixo de formato conhecido: ${matched} (${((matched / scanned) * 100).toFixed(2)}%)\n`);
  console.log(`  ${"contagem".padStart(8)}  ${"%".padStart(6)}  prefixo`);
  for (const [prefix, entry] of sorted) {
    console.log(`  ${String(entry.count).padStart(8)}  ${((entry.count / scanned) * 100).toFixed(2).padStart(6)}  "${prefix}"`);
  }

  console.log(`\n── amostra por prefixo ──`);
  for (const [prefix, entry] of sorted) {
    console.log(`\n  "${prefix}" (${entry.count}):`);
    entry.samples.forEach((s) => console.log(`    ${s.sku}  "${s.title}"`));
  }

  console.log(`\n(nada escrito — dry-run. Bloqueia --execute da Tarefa 10, Decisão 16.)`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
