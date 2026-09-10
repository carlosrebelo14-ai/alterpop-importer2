#!/usr/bin/env node
/**
 * BRIEFING · Tarefa 6 — reconciliador `alterpop.franchise` / `alterpop.line` entre o
 * que está nos produtos Shopify e o que a Prisma (resolver) diz que deviam ter.
 *
 * MODO DIFF por defeito (read-only). Percorre todos os produtos da loja, cruza por SKU
 * com `CatalogProduct` (resolvedFranchise / resolvedLine) e classifica cada divergência:
 *
 *   MISSING       resolvedFranchise/Line definido, mas o produto não tem o metafield
 *   DRIFT         o produto tem o metafield com valor diferente do resolvido (code point)
 *   ORPHAN_LINE   tem alterpop.line mas o alterpop.franchise não contém o parent da Line
 *                 (ou não tem alterpop.franchise de todo)
 *   UNKNOWN       valor de franchise/line que não existe nas tabelas (39 universos / Lines)
 *   NO_CATALOG_ROW  SKU do produto sem linha em CatalogProduct — não dá para verificar
 *
 * Multi-valor: `alterpop.franchise` é lista; "correto" = a lista CONTÉM o valor
 * resolvido (crossover manual fica válido).
 *
 * `--execute` ainda não implementado (só reporta que faria).
 *
 * Correr na Fla:  node scripts/catalog/franchise-reconcile.js
 *                 node scripts/catalog/franchise-reconcile.js --json
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";
import { FRANCHISE_LINES } from "../../lib/importer/catalog/franchiseLines.js";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const EXECUTE = args.includes("--execute");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const nfc = (s) => (s == null ? s : String(s).normalize("NFC"));
const UNIVERSE_NAMES = new Set(FRANCHISE_UNIVERSES.map((u) => nfc(u.name)));
const LINE_BY_NAME = new Map(FRANCHISE_LINES.map((l) => [nfc(l.line), l]));

const PRODUCTS_PAGE = `
  query Reconcile($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title status
        variants(first: 5) { nodes { sku } }
        metafields(first: 25, namespace: "alterpop") { nodes { key value } }
      }
    }
  }
`;

function parseList(raw) {
  try {
    const v = JSON.parse(raw ?? "null");
    return Array.isArray(v) ? v.map((x) => nfc(String(x))) : v == null ? [] : [nfc(String(v))];
  } catch {
    return raw ? [nfc(String(raw))] : [];
  }
}

async function fetchAllProducts(client) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 200; p++) {
    const d = await client.graphql(PRODUCTS_PAGE, { cursor });
    const conn = d?.products;
    for (const n of conn?.nodes || []) out.push(n);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const products = await fetchAllProducts(client);

  // mapa SKU → { resolvedFranchise, resolvedLine } (uma query por todos os SKUs vistos)
  const skus = [...new Set(products.flatMap((p) => (p.variants?.nodes || []).map((v) => v.sku).filter(Boolean)))];
  const rows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, sku: { in: skus } },
    select: { sku: true, resolvedFranchise: true, resolvedLine: true },
  });
  const expBySku = new Map(rows.map((r) => [r.sku, r]));

  const buckets = { MISSING: [], DRIFT: [], ORPHAN_LINE: [], UNKNOWN: [], NO_CATALOG_ROW: [] };

  for (const p of products) {
    const pid = p.id.split("/").pop();
    const skusP = (p.variants?.nodes || []).map((v) => v.sku).filter(Boolean);
    const mf = Object.fromEntries((p.metafields?.nodes || []).map((m) => [m.key, m.value]));
    const franchiseVals = parseList(mf.franchise);
    const lineVals = parseList(mf.line);

    // expectativa: primeira variante com linha no catálogo
    let exp = null;
    for (const s of skusP) if (expBySku.has(s)) { exp = expBySku.get(s); break; }

    const tag = (b, msg) => buckets[b].push(`${pid} "${p.title.slice(0, 44)}" — ${msg}`);

    // UNKNOWN: valores fora das tabelas
    for (const v of franchiseVals) if (!UNIVERSE_NAMES.has(v)) tag("UNKNOWN", `alterpop.franchise="${v}" não está nos 39 universos`);
    for (const v of lineVals) if (!LINE_BY_NAME.has(v)) tag("UNKNOWN", `alterpop.line="${v}" não está na tabela de Lines`);

    // ORPHAN_LINE: line sem parent coerente
    for (const lv of lineVals) {
      const line = LINE_BY_NAME.get(lv);
      if (!line) continue; // já apanhado em UNKNOWN
      if (!franchiseVals.length) tag("ORPHAN_LINE", `tem alterpop.line="${lv}" mas nenhum alterpop.franchise`);
      else if (!franchiseVals.includes(nfc(line.parent))) tag("ORPHAN_LINE", `alterpop.line="${lv}" mas alterpop.franchise=${JSON.stringify(franchiseVals)} não contém o parent "${line.parent}"`);
    }

    if (!exp) {
      // sem linha no catálogo: só reporta se o produto tiver algum metafield alterpop (senão é ruído)
      if (franchiseVals.length || lineVals.length) buckets.NO_CATALOG_ROW.push(`${pid} "${p.title.slice(0, 44)}" skus=[${skusP.join(",")}] mf=${JSON.stringify({ franchise: franchiseVals, line: lineVals })}`);
      continue;
    }

    const expF = nfc(exp.resolvedFranchise);
    const expL = nfc(exp.resolvedLine);

    if (expF) {
      if (!franchiseVals.length) tag("MISSING", `resolvido "${expF}", produto sem alterpop.franchise`);
      else if (!franchiseVals.includes(expF)) tag("DRIFT", `resolvido "${expF}", produto tem ${JSON.stringify(franchiseVals)}`);
    }
    if (expL) {
      if (!lineVals.length) tag("MISSING", `resolvido line "${expL}", produto sem alterpop.line`);
      else if (!lineVals.includes(expL)) tag("DRIFT", `resolvido line "${expL}", produto tem ${JSON.stringify(lineVals)}`);
    }
    // line no produto que o resolver NÃO previu (e não é crossover manual coerente)
    if (!expL && lineVals.length) tag("DRIFT", `produto tem alterpop.line ${JSON.stringify(lineVals)} mas o resolvido não tem line`);
  }

  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));

  if (JSON_OUT) {
    console.log(JSON.stringify({ shop: SHOP, productsScanned: products.length, counts, buckets }, null, 2));
  } else {
    console.log(`=== franchise-reconcile (${SHOP})${EXECUTE ? "" : " · DIFF"} ===`);
    console.log(`produtos verificados: ${products.length}\n`);
    console.log(`  MISSING        ${counts.MISSING}`);
    console.log(`  DRIFT          ${counts.DRIFT}`);
    console.log(`  ORPHAN_LINE    ${counts.ORPHAN_LINE}`);
    console.log(`  UNKNOWN        ${counts.UNKNOWN}`);
    console.log(`  NO_CATALOG_ROW ${counts.NO_CATALOG_ROW}`);
    for (const [k, v] of Object.entries(buckets)) {
      if (!v.length) continue;
      console.log(`\n── ${k} ──`);
      for (const line of v) console.log(`  ${line}`);
    }
    if (!counts.MISSING && !counts.DRIFT && !counts.ORPHAN_LINE && !counts.UNKNOWN) {
      console.log(`\n✓ reconciliação limpa (MISSING/DRIFT/ORPHAN_LINE/UNKNOWN = 0).`);
    }
    if (EXECUTE) console.log(`\n--execute ainda não implementado — este script só reporta.`);
  }

  await prisma.$disconnect();
  if (counts.MISSING || counts.DRIFT || counts.ORPHAN_LINE || counts.UNKNOWN) process.exit(1);
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
