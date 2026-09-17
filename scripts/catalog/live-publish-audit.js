#!/usr/bin/env node
/**
 * B18 (briefing backend, 17/09/2026), item 2 — live-publish-audit.js.
 *
 * SÓ LEITURA. Corre prePublishChecks.server.js sobre TODOS os produtos ACTIVE da loja,
 * com o payload reconstruído a partir do CatalogProduct (Prisma) via buildPublishPayload
 * (shopifyMapper.server.js) — a mesma função que o publisher usa, nunca uma segunda
 * implementação.
 *
 * TITLE_DUPLICATE compara contra os títulos LIVE de todos os ACTIVE (é aí que a
 * duplicação existe hoje). As outras quatro verificações correm sobre o payload
 * RECONSTRUÍDO (o que deveria estar, segundo o Prisma) — MISSING_FRANCHISE/
 * MISSING_FORMAT/SUPPLIER_TOKENS/PREFIX_RESIDUE são sobre o valor esperado, não uma
 * leitura de metafield.
 *
 * Saída: lista por código, com handle, SKU, valor live e valor esperado.
 *
 * Correr na Fly: node scripts/catalog/live-publish-audit.js
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { buildPublishPayload } from "../../lib/importer/shopify/shopifyMapper.server.js";
import { runPrePublishChecks, checkTitleDuplicate } from "../../lib/importer/curation/prePublishChecks.server.js";
import { computeLiveDrift } from "../../lib/importer/curation/liveDrift.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

const ACTIVE_PRODUCTS_QUERY = `
  query LiveAuditActive($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        descriptionHtml
        vendor
        variants(first: 1) { nodes { sku price } }
        metafields(namespace: "alterpop", first: 10) { nodes { key value } }
      }
    }
  }
`;

async function fetchAllActive(client) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(ACTIVE_PRODUCTS_QUERY, { cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) out.push(n);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

function metafieldValue(node, key) {
  const m = (node.metafields?.nodes || []).find((mf) => mf.key === key);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m.value);
    return Array.isArray(parsed) ? parsed[0] ?? null : m.value;
  } catch {
    return m.value;
  }
}

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  console.log(`\n=== live-publish-audit (${SHOP}) — SÓ LEITURA ===\n`);

  const activeNodes = await fetchAllActive(client);
  console.log(`produtos ACTIVE: ${activeNodes.length}\n`);

  const activeProducts = activeNodes
    .map((n) => ({ sku: n.variants?.nodes?.[0]?.sku || null, title: n.title, handle: n.handle }))
    .filter((p) => p.sku);

  const findings = [];
  let skippedNoCatalogRow = 0;

  for (const node of activeNodes) {
    const sku = node.variants?.nodes?.[0]?.sku || null;
    if (!sku) continue;

    const row = await prisma.catalogProduct.findFirst({ where: { shop: SHOP, sku } });
    if (!row) {
      skippedNoCatalogRow += 1;
      console.warn(`[live-publish-audit] sem linha CatalogProduct para SKU ${sku} (${node.handle}) — não auditado`);
      continue;
    }

    const payload = await buildPublishPayload(row);

    // TITLE_DUPLICATE contra os títulos LIVE — é aí que a duplicação vive hoje.
    const titleDup = checkTitleDuplicate({ sku, title: node.title }, { activeProducts });
    if (titleDup) {
      findings.push({
        code: "TITLE_DUPLICATE",
        handle: node.handle,
        sku,
        live: node.title,
        expected: payload.title,
        evidence: titleDup.evidence,
      });
    }

    // As restantes quatro correm sobre o payload reconstruído (o esperado).
    const rest = runPrePublishChecks(payload, {}).filter((w) => w.code !== "TITLE_DUPLICATE");
    for (const w of rest) {
      const liveByCode = {
        PREFIX_RESIDUE: node.title,
        MISSING_FRANCHISE: metafieldValue(node, "franchise"),
        MISSING_FORMAT: metafieldValue(node, "format"),
        SUPPLIER_TOKENS: node.descriptionHtml,
      };
      const expectedByCode = {
        PREFIX_RESIDUE: payload.title,
        MISSING_FRANCHISE: payload.resolvedFranchise,
        MISSING_FORMAT: payload.resolvedFormat,
        SUPPLIER_TOKENS: payload.descriptionHtml,
      };
      findings.push({
        code: w.code,
        handle: node.handle,
        sku,
        live: liveByCode[w.code] ?? null,
        expected: expectedByCode[w.code] ?? null,
        evidence: w.evidence,
      });
    }

    // LIVE_DRIFT (ADENDA 5, 17/09/2026) — MISSING_FRANCHISE/MISSING_FORMAT acima só
    // veem o payload reconstruído: ficam verdes assim que o Prisma tem valor, mesmo que
    // a Shopify continue com o metafield vazio de uma publicação anterior (o backfill
    // de resolvedFormat/resolvedManufacturerLine nunca chama metafieldsSet). Esta
    // comparação olha para o valor REAL na loja, não só para o esperado.
    const liveValues = {
      franchise: metafieldValue(node, "franchise"),
      line: metafieldValue(node, "line"),
      format: metafieldValue(node, "format"),
      manufacturer_line: metafieldValue(node, "manufacturer_line"),
    };
    for (const drift of computeLiveDrift(payload, liveValues)) {
      findings.push({ code: "LIVE_DRIFT", handle: node.handle, sku, live: drift.live, expected: drift.expected, evidence: { field: drift.field } });
    }
  }

  const byCode = new Map();
  for (const f of findings) {
    if (!byCode.has(f.code)) byCode.set(f.code, []);
    byCode.get(f.code).push(f);
  }

  for (const [code, list] of byCode) {
    console.log(`\n── ${code} (${list.length}) ──`);
    for (const f of list) {
      const liveStr = typeof f.live === "string" && f.live.length > 120 ? f.live.slice(0, 120) + "…" : f.live;
      const expStr = typeof f.expected === "string" && f.expected.length > 120 ? f.expected.slice(0, 120) + "…" : f.expected;
      console.log(`  ${f.sku}  ${f.handle}`);
      console.log(`    live:     ${JSON.stringify(liveStr)}`);
      console.log(`    esperado: ${JSON.stringify(expStr)}`);
      if (f.evidence && Object.keys(f.evidence).length) {
        console.log(`    evidence: ${JSON.stringify(f.evidence)}`);
      }
    }
  }

  console.log(
    `\n=== DONE. produtos_active=${activeNodes.length} auditados=${activeNodes.length - skippedNoCatalogRow} sem_linha_prisma=${skippedNoCatalogRow} findings=${findings.length} ===`
  );
}

main()
  .catch((err) => {
    console.error("[live-publish-audit] fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
