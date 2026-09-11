#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 18 — sobreposição kpop. Alimenta a Decisão 7.
 *
 * SÓ RELATÓRIO. Conta quantos órfãos com o token "kpop" no título também contêm
 * "demon" ou "hunters" — se a sobreposição for maioritária, "KPop Demon Hunters" é
 * quase de certeza a mesma propriedade (Decisão 7) e não um género musical à parte.
 * Se a maioria dos "kpop" ficar fora dessas duas palavras, o resto continua órfão.
 *
 * Correr na Fly:  node scripts/catalog/kpop-demon-hunters-overlap.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";

const SHOP =
  (process.argv.indexOf("--shop") >= 0 && process.argv[process.argv.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const PAGE = 500;

function normText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function main() {
  let cursor = null;
  let kpopTotal = 0;
  let kpopWithDemonHunters = 0;
  const kpopOnly = [];
  const kpopWith = [];

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP, resolvedFranchise: null, title: { contains: "kpop" } },
      select: { sku: true, title: true, franchiseRefs: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      const t = ` ${normText(r.title)} `;
      if (!t.includes(" kpop ")) continue; // "kpop" como palavra inteira, não substring de outra
      kpopTotal += 1;
      const hasDemonHunters = t.includes(" demon ") || t.includes(" hunters ") || t.includes(" hunter ");
      if (hasDemonHunters) {
        kpopWithDemonHunters += 1;
        if (kpopWith.length < 10) kpopWith.push({ sku: r.sku, title: r.title });
      } else if (kpopOnly.length < 15) {
        kpopOnly.push({ sku: r.sku, title: r.title, refs: r.franchiseRefs });
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  const pct = kpopTotal ? ((kpopWithDemonHunters / kpopTotal) * 100).toFixed(1) : "0.0";
  console.log(`\n=== kpop-demon-hunters-overlap (${SHOP}) — Tarefa 18 ===\n`);
  console.log(`órfãos com "kpop" (palavra inteira) no título: ${kpopTotal}`);
  console.log(`desses, também "demon"/"hunter(s)": ${kpopWithDemonHunters} (${pct}%)`);
  console.log(`desses, SEM "demon"/"hunter(s)": ${kpopTotal - kpopWithDemonHunters}`);

  console.log(`\n── amostra kpop COM demon/hunters (${kpopWith.length}) ──`);
  kpopWith.forEach((r) => console.log(`  ${r.sku}  "${r.title}"`));

  console.log(`\n── amostra kpop SEM demon/hunters (${kpopOnly.length}) ──`);
  kpopOnly.forEach((r) => console.log(`  ${r.sku}  "${r.title}"  refs=${r.refs}`));

  console.log(
    `\nveredicto: ${
      Number(pct) >= 60
        ? "sobreposição MAIORITÁRIA — kpop e KPop Demon Hunters são a mesma propriedade (Decisão 7 confirmada)."
        : "sobreposição MINORITÁRIA — kpop não é maioritariamente o filme; universo fica restrito aos casos com demon/hunters, resto continua órfão."
    }`
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
