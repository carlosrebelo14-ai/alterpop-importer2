#!/usr/bin/env node
/**
 * B7 (briefing backend, 17/09/2026) — backfill de `resolvedCharacters`, secção 8 passo 3
 * do arranque. characterResolver.server.js aplicado a todo o CatalogProduct.
 *
 * DRY-RUN por defeito: distribuição de handles (contagem + amostra) sobre TODO o
 * catálogo Prisma E, à parte, restrita aos SKUs hoje ACTIVE na loja (secção 3/7 do
 * arranque — só esse subconjunto decide o que atinge o limiar de 3 do piloto). Sem
 * aprovação prévia para `--execute` — mesma régua da Decisão 18 (format-extract-dryrun.js).
 *
 * `--execute`: grava `resolvedCharacters` (JSON de handles, ou NULL) em todo o
 * catálogo, por página de cursor. NUNCA toca em title/franchise/nenhum outro campo.
 *
 * P1 (ADENDA 3, 17/09/2026) — mesma verificação de paginação incompleta já aplicada ao
 * format-extract-dryrun.js e ao backfill de manufacturer_line: compara o `scanned`
 * contra a contagem do catálogo NO FIM da corrida, porque há escrita concorrente
 * (sync em background) e uma página curta não prova por si só que acabou.
 *
 * Correr na Fly:  node scripts/catalog/character-backfill.js
 *                 node scripts/catalog/character-backfill.js --execute
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { resolveCharacters } from "../../lib/importer/catalog/characterResolver.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const PAGE = 500;

function computeHandles(row) {
  return resolveCharacters({
    originalTitle: row.originalTitle || row.title,
    titleOverride: row.titleOverride,
    resolvedFranchise: row.resolvedFranchise,
  });
}

const ACTIVE_PRODUCTS_QUERY = `
  query CharacterBackfillActive($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        variants(first: 1) { nodes { sku } }
      }
    }
  }
`;

/** SKUs ACTIVE na loja agora mesmo — só leitura, mesmo padrão do live-title-reconcile.js. */
async function fetchLiveActiveSkus() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const skus = new Set();
  let cursor = null;
  for (;;) {
    const data = await client.graphql(ACTIVE_PRODUCTS_QUERY, { cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) {
      const sku = n.variants?.nodes?.[0]?.sku;
      if (sku) skus.add(sku);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return skus;
}

function bump(map, handle, sku, title) {
  if (!map.has(handle)) map.set(handle, { count: 0, samples: [] });
  const entry = map.get(handle);
  entry.count += 1;
  if (entry.samples.length < 8) entry.samples.push({ sku, title });
}

function reportDistribution(label, counts, totalScanned, semCharacter) {
  console.log(`\n── ${label} (${totalScanned} produtos, ${semCharacter} sem Character) ──`);
  const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  if (!sorted.length) {
    console.log(`  (nenhum handle)`);
    return;
  }
  console.log(`  ${"contagem".padStart(8)}  handle`);
  for (const [handle, entry] of sorted) {
    console.log(`  ${String(entry.count).padStart(8)}  ${handle}`);
  }
}

async function dryRun() {
  console.log(`\n=== character-backfill (${SHOP}) · DRY-RUN ===\n`);

  let liveSkus;
  try {
    liveSkus = await fetchLiveActiveSkus();
  } catch (err) {
    throw new Error(`FALHA A LER A LOJA (produtos ACTIVE): ${err?.message || err}`);
  }
  console.log(`produtos ACTIVE na loja: ${liveSkus.size}`);

  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  const catalogCounts = new Map();
  const liveCounts = new Map();
  let catalogSemCharacter = 0;
  let liveSemCharacter = 0;
  let liveScanned = 0;
  let scanned = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, originalTitle: true, titleOverride: true, resolvedFranchise: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      scanned += 1;
      const isLive = liveSkus.has(r.sku);
      if (isLive) liveScanned += 1;

      const handles = computeHandles(r);
      if (!handles) {
        catalogSemCharacter += 1;
        if (isLive) liveSemCharacter += 1;
        continue;
      }
      for (const handle of handles) {
        bump(catalogCounts, handle, r.sku, r.title);
        if (isLive) bump(liveCounts, handle, r.sku, r.title);
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  // P1 — ver nota de topo.
  const totalAtEnd = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  if (scanned !== totalAtEnd) {
    throw new Error(
      `paginação incompleta: analisados=${scanned}, catálogo agora=${totalAtEnd} (era ${total} ao início) — corre outra vez`
    );
  }

  reportDistribution("catálogo Prisma completo", catalogCounts, scanned, catalogSemCharacter);
  reportDistribution(
    `produtos ACTIVE na loja (${liveScanned}/${liveSkus.size} SKUs ACTIVE encontrados no catálogo Prisma)`,
    liveCounts,
    liveScanned,
    liveSemCharacter
  );

  console.log(`\n── candidatos a metaobject ACTIVE no piloto (>= 3 produtos live) ──`);
  const sortedLive = [...liveCounts.entries()].sort((a, b) => b[1].count - a[1].count);
  const acimaDoLimiar = sortedLive.filter(([, entry]) => entry.count >= 3);
  if (!acimaDoLimiar.length) {
    console.log(`  (nenhum)`);
  } else {
    for (const [handle, entry] of acimaDoLimiar) {
      console.log(`  ${handle}: ${entry.count} produtos live`);
    }
  }
  console.log(`\n── abaixo do limiar, para registo (secção 7: din-djarin pode aparecer aqui) ──`);
  const abaixoDoLimiar = sortedLive.filter(([, entry]) => entry.count > 0 && entry.count < 3);
  if (!abaixoDoLimiar.length) {
    console.log(`  (nenhum)`);
  } else {
    for (const [handle, entry] of abaixoDoLimiar) {
      console.log(`  ${handle}: ${entry.count} produto(s) live — ${entry.samples.map((s) => `${s.sku} "${s.title}"`).join(" | ")}`);
    }
  }

  console.log(`\n(nada escrito — dry-run.)`);
}

async function execute() {
  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== character-backfill (${SHOP}) · --execute · CatalogProduct: ${total} ===\n`);

  let processed = 0;
  let changed = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, originalTitle: true, titleOverride: true, resolvedFranchise: true, resolvedCharacters: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    const updates = [];
    for (const r of rows) {
      const handles = computeHandles(r);
      const serialized = handles ? JSON.stringify(handles) : null;
      if (r.resolvedCharacters !== serialized) {
        changed += 1;
        updates.push(
          prisma.catalogProduct.update({
            where: { shop_sku: { shop: SHOP, sku: r.sku } },
            data: { resolvedCharacters: serialized },
          })
        );
      }
    }
    if (updates.length) await prisma.$transaction(updates);

    processed += rows.length;
    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (processed % 5000 === 0 || rows.length < PAGE) console.log(`  ${processed}/${total}…`);
    if (rows.length < PAGE) break;
  }

  // P1 — ver nota de topo.
  const totalAtEnd = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  if (processed !== totalAtEnd) {
    throw new Error(
      `paginação incompleta: processados=${processed}, catálogo agora=${totalAtEnd} (era ${total} ao início) — corre outra vez`
    );
  }

  console.log(`\nprocessados: ${processed}  ·  resolvedCharacters alterado: ${changed}`);
}

async function main() {
  if (EXECUTE) await execute();
  else await dryRun();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
