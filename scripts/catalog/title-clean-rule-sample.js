#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 19 — amostra de 50 da regra `prefixo-formato`.
 *
 * SÓ RELATÓRIO. Continua a bloquear o `--execute` da Tarefa 10 até esta amostra ser
 * revista — é a regra que mais dispara (22,75% na amostra de 2000, Tarefa 10b), por
 * isso merece uma leitura dedicada antes de aprovar o backfill.
 *
 * Amostra ALEATÓRIA de 50 (por omissão) produtos onde a regra `prefixo-formato` do
 * titleCleaner dispara, antes/depois lado a lado.
 *
 * Correr na Fly:  node scripts/catalog/title-clean-rule-sample.js
 *                 node scripts/catalog/title-clean-rule-sample.js --rule dash-repetido --n 50
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { cleanProductTitleWithTrace } from "../../lib/importer/catalog/titleCleaner.server.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const RULE = valOf("--rule", "prefixo-formato");
const N = parseInt(valOf("--n", "50"), 10) || 50;
const PAGE = 500;

function shuffleSample(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function main() {
  console.log(`\n=== title-clean-rule-sample (${SHOP}) — regra "${RULE}" · Tarefa 19 ===\n`);

  const matches = [];
  let scanned = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, resolvedFranchise: true, resolvedLine: true, resolvedFormat: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      scanned += 1;
      const { result, firedRules } = cleanProductTitleWithTrace(r);
      if (firedRules.includes(RULE)) matches.push({ sku: r.sku, before: r.title, after: result, firedRules });
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`produtos analisados: ${scanned}`);
  console.log(`regra "${RULE}" dispara em: ${matches.length} (${((matches.length / scanned) * 100).toFixed(2)}%)\n`);

  const sample = shuffleSample(matches, Math.min(N, matches.length));
  console.log(`amostra aleatória: ${sample.length}\n`);
  for (const m of sample) {
    console.log(`  ${m.sku}  [${m.firedRules.join(", ")}]`);
    console.log(`    antes : "${m.before}"`);
    console.log(`    depois: "${m.after}"`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
