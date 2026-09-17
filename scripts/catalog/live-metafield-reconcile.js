#!/usr/bin/env node
/**
 * LIVE_DRIFT (ADENDA 5, briefing backend, 17/09/2026) — live-metafield-reconcile.js.
 *
 * A auditoria (live-publish-audit.js) descobriu que MISSING_FRANCHISE/MISSING_FORMAT só
 * viam o payload reconstruído (o esperado, do Prisma) — ficavam verdes assim que o
 * Prisma tinha valor, mesmo com o metafield vazio na loja de uma publicação anterior.
 * Este script escreve a correção — SÓ metafields `alterpop.*`, nunca productUpdate
 * (título, vendor, descrição, status, tags ficam intocados).
 *
 * DRY-RUN por omissão. `--execute` escreve via metafieldsSet, um metafield por campo em
 * drift, com o mesmo type/formato que o publisher usa (shopifyProductPublisher.server.js):
 *   franchise / line / format   → list.single_line_text_field, JSON.stringify([valor])
 *   manufacturer_line           → single_line_text_field, valor escalar
 *
 * Só escreve quando o valor ESPERADO é não-nulo (mesma convenção do publisher: nunca
 * grava vazio). Quando o esperado é null mas a loja tem um valor antigo, não há
 * metafieldsSet que apague — precisava de metafieldsDelete, fora do âmbito deste
 * script — é reportado à parte, nunca escrito silenciosamente.
 *
 * Correr na Fly:
 *   node scripts/catalog/live-metafield-reconcile.js
 *   node scripts/catalog/live-metafield-reconcile.js --execute
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { buildPublishPayload } from "../../lib/importer/shopify/shopifyMapper.server.js";
import { computeLiveDrift } from "../../lib/importer/curation/liveDrift.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const EXECUTE = process.argv.includes("--execute");

const LIST_FIELDS = new Set(["franchise", "line", "format"]);

const ACTIVE_PRODUCTS_QUERY = `
  query MetafieldReconcileActive($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        variants(first: 1) { nodes { sku } }
        metafields(namespace: "alterpop", first: 10) { nodes { key value } }
      }
    }
  }
`;

const METAFIELDS_SET = `
  mutation MetafieldReconcileSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key value }
      userErrors { field message }
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

  console.log(`\n=== live-metafield-reconcile (${SHOP}) · ${EXECUTE ? "EXECUTE" : "DRY-RUN"} ===\n`);

  const activeNodes = await fetchAllActive(client);
  console.log(`produtos ACTIVE: ${activeNodes.length}\n`);

  let skippedNoCatalogRow = 0;
  let cannotClear = 0;
  let toReconcile = 0;
  let updated = 0;
  const cannotClearList = [];
  const reconciled = [];

  for (const node of activeNodes) {
    const sku = node.variants?.nodes?.[0]?.sku || null;
    if (!sku) continue;

    const row = await prisma.catalogProduct.findFirst({ where: { shop: SHOP, sku } });
    if (!row) {
      skippedNoCatalogRow += 1;
      continue;
    }

    const payload = await buildPublishPayload(row);
    const liveValues = {
      franchise: metafieldValue(node, "franchise"),
      line: metafieldValue(node, "line"),
      format: metafieldValue(node, "format"),
      manufacturer_line: metafieldValue(node, "manufacturer_line"),
    };

    for (const drift of computeLiveDrift(payload, liveValues)) {
      if (!drift.expected) {
        cannotClear += 1;
        cannotClearList.push({ sku, handle: node.handle, field: drift.field, live: drift.live });
        continue;
      }

      toReconcile += 1;
      reconciled.push({ sku, handle: node.handle, id: node.id, field: drift.field, live: drift.live, expected: drift.expected });

      if (EXECUTE) {
        const isList = LIST_FIELDS.has(drift.field);
        const data = await client.graphql(METAFIELDS_SET, {
          metafields: [
            {
              ownerId: node.id,
              namespace: "alterpop",
              key: drift.field,
              type: isList ? "list.single_line_text_field" : "single_line_text_field",
              value: isList ? JSON.stringify([drift.expected]) : drift.expected,
            },
          ],
        });
        const errors = data.metafieldsSet?.userErrors || [];
        if (errors.length) {
          console.error(`  ✗ ${sku} (${node.handle}) ${drift.field}: ${errors.map((e) => e.message).join("; ")}`);
          continue;
        }
        updated += 1;
      }
    }
  }

  if (cannotClearList.length) {
    console.log(`── esperado vazio, live tem valor antigo — precisa de metafieldsDelete, FORA DO ÂMBITO (${cannotClearList.length}) ──`);
    for (const c of cannotClearList) {
      console.log(`  ${c.sku}  ${c.handle}  alterpop.${c.field}`);
      console.log(`    live:      ${JSON.stringify(c.live)}`);
      console.log(`    esperado:  null`);
    }
    console.log();
  }

  if (reconciled.length) {
    console.log(`── ${EXECUTE ? "atualizados" : "seriam atualizados"} (${reconciled.length}) ──`);
    for (const r of reconciled) {
      console.log(`  ${r.sku}  ${r.handle}  alterpop.${r.field}`);
      console.log(`    live:  ${JSON.stringify(r.live)}`);
      console.log(`    novo:  ${JSON.stringify(r.expected)}`);
    }
    console.log();
  }

  console.log(
    `=== DONE. ativos=${activeNodes.length} sem_linha_prisma=${skippedNoCatalogRow} ` +
      `precisa_delete_fora_ambito=${cannotClear} ${EXECUTE ? "atualizados" : "a_reconciliar"}=${EXECUTE ? updated : toReconcile} ===`
  );
  if (!EXECUTE && toReconcile > 0) {
    console.log(`\n(nada escrito — dry-run. Corre com --execute só se o resultado for exatamente o esperado.)`);
  }
}

main()
  .catch((err) => {
    console.error("[live-metafield-reconcile] fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
