#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 14 — camada 3 de chapéu. DRY-RUN SEMPRE.
 *
 * `resolveUmbrella()` (franchiseResolver.server.js) NÃO está ligada a
 * resolveFranchise() nem ao publisher — só existe para este relatório, até haver
 * aprovação explícita. Este script não escreve nada em BD/Shopify.
 *
 * Para cada órfão (resolvedFranchise NULL), testa Disney/Marvel como universo de
 * chapéu (ref DISNEY/MARVEL, ou o nome como token no título). Quem batesse levaria
 * `UMBRELLA` no relatório real, para reclassificação futura (Tarefa 15 vai tirando
 * produtos concretos do chapéu à medida que universos próprios entram na tabela).
 *
 * Correr na Fly:  node scripts/catalog/franchise-umbrella-dryrun.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { resolveUmbrella } from "../../lib/importer/catalog/franchiseResolver.server.js";

const SHOP =
  (process.argv.indexOf("--shop") >= 0 && process.argv[process.argv.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const PAGE = 500;

function parseRefs(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(`\n=== franchise-umbrella-dryrun (${SHOP}) — DRY-RUN, nada escrito ===\n`);

  const byUmbrella = new Map(); // handle -> { name, count, samples: [] }
  let cursor = null;
  let orphansSeen = 0;
  let stillOrphan = 0;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP, resolvedFranchise: null },
      select: { sku: true, title: true, franchiseRefs: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      orphansSeen += 1;
      const hit = resolveUmbrella({ franchiseRefs: parseRefs(r.franchiseRefs), title: r.title });
      if (!hit) {
        stillOrphan += 1;
        continue;
      }
      let bucket = byUmbrella.get(hit.handle);
      if (!bucket) {
        bucket = { name: hit.franchise, count: 0, samples: [] };
        byUmbrella.set(hit.handle, bucket);
      }
      bucket.count += 1;
      if (bucket.samples.length < 10) bucket.samples.push({ sku: r.sku, title: r.title, matchedOn: hit.matchedOn });
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`órfãos analisados: ${orphansSeen}`);
  for (const [handle, b] of byUmbrella) {
    console.log(`\n── UMBRELLA: ${b.name} (${handle}) — ${b.count} produto(s) ──`);
    b.samples.forEach((s) => console.log(`    ${s.sku}  "${s.title}"  (matchedOn: ${s.matchedOn})`));
  }
  console.log(`\nórfãos que continuam sem sinal nenhum (nem chapéu): ${stillOrphan}`);
  console.log(`\n(nada escrito — resolveUmbrella() não está ligada ao publisher nem à BD)`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
