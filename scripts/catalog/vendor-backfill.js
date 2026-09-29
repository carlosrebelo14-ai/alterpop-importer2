#!/usr/bin/env node
/**
 * C2 (briefing 29/09/2026) — vendor dos produtos ACTIVE passa do valor do feed
 * ("BANPRESTO") para o nome do mapa BRAND_DISPLAY_NAMES ("Banpresto").
 *
 * Dry-run por omissão. Escreve só com --execute. EXCEÇÃO à regra de escrita, só neste
 * script: productUpdate com input { id, vendor, descriptionHtml } e mais nada.
 *
 * descriptionHtml (ajuste de 29/09): as descrições têm o link de marca
 * filter.p.vendor=<CHAVE>; sem trocar, partiam todas ao mesmo tempo que o vendor muda.
 * Troca SÓ esse link (rewriteVendorLink, brandDisplayNames.js); se a descrição mudasse
 * em qualquer outro ponto, o produto é RECUSADO inteiro — nem vendor nem descrição.
 * O texto visível da marca na descrição fica para a republicação.
 *
 * Chave: vendor do feed em CatalogProduct (Prisma); sem linha no catálogo, o vendor live.
 * Vendor fora do mapa → VENDOR_UNMAPPED, não toca. sync_locked → de fora sem
 * --include-locked.
 *
 * O dry-run também mede o que este script NÃO muda: ociostock.brand com o valor antigo
 * (o publisher reescreve-o na republicação).
 *
 *   flyctl ssh console -a alterpop-importer-app -C "node scripts/catalog/vendor-backfill.js"
 *   flyctl ssh console -a alterpop-importer-app -C "node scripts/catalog/vendor-backfill.js --execute"
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { planVendorBackfill, vendorLinkToken, BRAND_DISPLAY_NAMES } from "../../lib/importer/catalog/brandDisplayNames.js";
import { reportBatchDone } from "../../lib/maintenance/batchReport.js";

const TAG = "vendor-backfill";
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const INCLUDE_LOCKED = args.includes("--include-locked");

const READ = `
  query VendorBackfillRead($query: String!, $cursor: String) {
    products(first: 100, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        vendor
        descriptionHtml
        variants(first: 1) { nodes { sku } }
        syncLocked: metafield(namespace: "ociostock", key: "sync_locked") { value }
        brand: metafield(namespace: "ociostock", key: "brand") { value }
      }
    }
  }
`;

const UPDATE = `
  mutation VendorBackfillUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id vendor descriptionHtml }
      userErrors { field message }
    }
  }
`;

async function readActive(client) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(READ, { query: "status:active", cursor });
    const conn = data?.products;
    out.push(...(conn?.nodes || []));
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

async function toPlanInput(nodes) {
  const rows = [];
  for (const n of nodes) {
    const sku = n.variants?.nodes?.[0]?.sku || null;
    const row = sku ? await prisma.catalogProduct.findFirst({ where: { shop: SHOP, sku }, select: { vendor: true } }) : null;
    rows.push({
      productId: n.id,
      handle: n.handle,
      sku,
      liveVendor: n.vendor || null,
      feedVendor: row?.vendor || null,
      syncLocked: n.syncLocked?.value === "true",
      descriptionHtml: n.descriptionHtml || "",
      brand: n.brand?.value ?? null,
    });
  }
  return rows;
}

async function main() {
  console.log(`=== ${TAG} (${SHOP}) · ${EXECUTE ? "EXECUTE" : "dry-run"} · ${Object.keys(BRAND_DISPLAY_NAMES).length} marcas no mapa${INCLUDE_LOCKED ? " · COM sync_locked" : ""} ===`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const products = await toPlanInput(await readActive(client));
  const plan = planVendorBackfill(products, { includeLocked: INCLUDE_LOCKED });
  if (plan.processed !== products.length) {
    console.error(`[${TAG}] FATAL: processed (${plan.processed}) != lidos (${products.length})`);
    process.exit(1);
  }

  console.log(`\nACTIVE: ${products.length} · a mudar: ${plan.updates.length} · já certos: ${plan.alreadyOk} · recusados: ${plan.refused.length} · VENDOR_UNMAPPED: ${plan.unmapped.length} · sync_locked de fora: ${plan.lockedSkipped.length} · sem vendor: ${plan.noVendor}`);

  const byChange = new Map();
  for (const u of plan.updates) byChange.set(`${u.from} → ${u.to}`, (byChange.get(`${u.from} → ${u.to}`) || 0) + 1);
  console.log(`\nmudanças de vendor:`);
  for (const [k, n] of [...byChange].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

  const withLink = plan.updates.filter((u) => u.linksReplaced > 0);
  console.log(`\nlink de marca na descrição: ${withLink.length} de ${plan.updates.length} a trocar (os outros não têm o link)`);

  if (plan.refused.length) {
    console.log(`\nRECUSADOS — descrição mudava fora do link, nada escrito nestes:`);
    for (const r of plan.refused) console.log(`  ${r.sku}  ${r.handle}: ${r.reason}`);
  }

  if (plan.unmapped.length) {
    const byKey = new Map();
    for (const u of plan.unmapped) byKey.set(u.key, (byKey.get(u.key) || 0) + 1);
    console.log(`\nVENDOR_UNMAPPED (não toca — acrescentar ao mapa é decisão):`);
    for (const [k, n] of byKey) console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  for (const l of plan.lockedSkipped) console.log(`  sync_locked, de fora: ${l.sku} ${l.handle} (${l.from} → ${l.to})`);

  const toUpdateIds = new Set(plan.updates.map((u) => u.productId));
  const staleBrand = products.filter((p) => toUpdateIds.has(p.productId) && p.brand && p.brand === p.liveVendor);
  console.log(`\nfora deste script (corrige-se na republicação): ociostock.brand com o valor antigo: ${staleBrand.length}`);

  console.log(`\npor produto (vendor antes → depois · link antes → depois):`);
  for (const u of plan.updates) {
    const link = u.linksReplaced > 0 ? `${vendorLinkToken(u.from).slice(0, -1)} → ${vendorLinkToken(u.to).slice(0, -1)} (${u.linksReplaced})` : "sem link";
    console.log(`  ${u.sku}  ${u.handle}: ${u.from} → ${u.to} · ${link}`);
  }

  if (!EXECUTE) {
    reportBatchDone({
      tag: TAG,
      itemsRead: products.length,
      processed: plan.processed,
      total: products.length,
      extra: `dry-run, nada escrito · a_mudar=${plan.updates.length} links=${withLink.length} recusados=${plan.refused.length} unmapped=${plan.unmapped.length}`,
    });
    return;
  }

  let done = 0;
  const errors = [];
  for (const u of plan.updates) {
    try {
      const input = { id: u.productId, vendor: u.to };
      if (u.descriptionHtml != null) input.descriptionHtml = u.descriptionHtml;
      const data = await client.graphql(UPDATE, { product: input });
      const ue = data.productUpdate?.userErrors || [];
      if (ue.length) throw new Error(ue.map((e) => e.message).join("; "));
      const got = data.productUpdate?.product;
      if (got?.vendor !== u.to) throw new Error(`devolveu vendor=${got?.vendor}`);
      if (u.descriptionHtml != null && !String(got?.descriptionHtml || "").includes(vendorLinkToken(u.to))) {
        throw new Error("descrição devolvida sem o link novo");
      }
      done += 1;
    } catch (err) {
      errors.push({ ...u, message: err?.message || String(err) });
      console.error(`[${TAG}] ERRO ${u.sku} ${u.handle}: ${err?.message || err}`);
    }
  }

  const after = planVendorBackfill(await toPlanInput(await readActive(client)), { includeLocked: INCLUDE_LOCKED });
  console.log(`\nreleitura: a mudar=${after.updates.length} (esperado 0) · já certos=${after.alreadyOk}`);
  reportBatchDone({
    tag: TAG,
    itemsRead: plan.updates.length,
    processed: done,
    total: plan.updates.length,
    // Recusados contam como erro: ficaram por migrar e pedem olho humano.
    errorCount: errors.length + after.updates.length + plan.refused.length,
    extra: `recusados=${plan.refused.length}`,
  });
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
