#!/usr/bin/env node
/**
 * C3 (briefing "catálogo limpo", 29/09/2026) — alterpop.format dos ACTIVE passa ao
 * vocabulário novo (FORMAT_VOCABULARY, formatExtractor.server.js). `Figure` sai.
 *
 * Dry-run por omissão. Escreve só com --execute: metafieldsSet para os valores novos e
 * metafieldsDelete em alterpop.format para os que ficam vazios mas têm valor live
 * antigo (EXCEÇÃO à regra de escrita, só neste script — decisão de 29/09/2026).
 *
 * Recusa escrever se:
 *   1. alguma regra de smart collection usar alterpop.format (pré-requisito do
 *      briefing; a Shopify também fecharia a definição);
 *   2. algum valor calculado estiver fora do vocabulário;
 *   3. o Prisma ainda tiver o vocabulário antigo — CatalogProduct.resolvedFormat tem de
 *      ser igual ao valor calculado aqui, ou seja, o indexador já correu com este
 *      código. Escrever antes punha a loja à frente do Prisma e o V13 via drift ao
 *      contrário.
 * sync_locked → de fora sem --include-locked.
 *
 * Reportado, não escrito: risco de título — produto que tinha formato e fica vazio; a
 * guarda do titleCleaner deixa de tirar o prefixo de formato na próxima indexação.
 *
 *   flyctl ssh console -a alterpop-importer-app -C "node scripts/catalog/format-backfill.js"
 *   flyctl ssh console -a alterpop-importer-app -C "node scripts/catalog/format-backfill.js --execute"
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { extractProductFormat, FORMAT_VOCABULARY } from "../../lib/importer/catalog/formatExtractor.server.js";
import {
  planFormatBackfill,
  formatMetafieldInput,
  formatMetafieldDeleteInput,
  emptiesByVendor,
  formatInputFromCatalogRow,
} from "../../lib/importer/catalog/formatBackfillPlan.js";
import { readSmartCollectionDefinitionUsage } from "../../lib/importer/shopify/metafieldSetup.js";
import { writeNewArrivalMetafields as writeMetafieldsBatched } from "../../lib/importer/shopify/newArrivals.server.js";
import { reportBatchDone } from "../../lib/maintenance/batchReport.js";

const TAG = "format-backfill";
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const INCLUDE_LOCKED = args.includes("--include-locked");

const READ = `
  query FormatBackfillRead($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        variants(first: 1) { nodes { sku } }
        format: metafield(namespace: "alterpop", key: "format") { value }
        syncLocked: metafield(namespace: "ociostock", key: "sync_locked") { value }
      }
    }
  }
`;

const METAFIELDS_DELETE = `
  mutation FormatBackfillClear($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { ownerId namespace key }
      userErrors { field message }
    }
  }
`;

const FORMAT_DEFINITION = `
  query FormatDefinitionId {
    metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "alterpop", key: "format") { nodes { id } }
  }
`;

const fatal = (msg) => {
  console.error(`[${TAG}] FATAL: ${msg}`);
  process.exit(1);
};

function firstListValue(value) {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed[0] ?? null : value;
  } catch {
    return value;
  }
}

async function readRows(client) {
  const nodes = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(READ, { cursor });
    const conn = data?.products;
    nodes.push(...(conn?.nodes || []));
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  const rows = [];
  for (const n of nodes) {
    const sku = n.variants?.nodes?.[0]?.sku || null;
    const row = sku
      ? await prisma.catalogProduct.findFirst({
          where: { shop: SHOP, sku },
          select: { title: true, vendor: true, resolvedFormat: true },
        })
      : null;
    rows.push({
      productId: n.id,
      handle: n.handle,
      sku,
      liveFormat: firstListValue(n.format?.value),
      // Mesmo input que o indexador (catalogProducts.server.js) — formatInputFromCatalogRow.
      computed: row ? extractProductFormat(formatInputFromCatalogRow({ ...row, sku })) : null,
      prismaFormat: row?.resolvedFormat ?? null,
      hasCatalogRow: !!row,
      syncLocked: n.syncLocked?.value === "true",
      vendor: row?.vendor || null,
      title: row?.title || null,
    });
  }
  return rows;
}

const printCounts = (label, entries) => {
  console.log(`  ${label}:`);
  for (const [v, n] of entries) console.log(`    ${String(n).padStart(4)}  ${v}`);
};

async function main() {
  console.log(`=== ${TAG} (${SHOP}) · ${EXECUTE ? "EXECUTE" : "dry-run"} · vocabulário: ${FORMAT_VOCABULARY.length} valores ===`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  // Guarda 1 — nenhuma smart collection pode usar alterpop.format.
  const defId = (await client.graphql(FORMAT_DEFINITION)).metafieldDefinitions?.nodes?.[0]?.id;
  if (!defId) fatal("definição alterpop.format não existe na loja.");
  const inUse = (await readSmartCollectionDefinitionUsage(client)).get(defId) || [];
  console.log(`\nregras de smart collection com alterpop.format: ${inUse.length}${inUse.length ? ` (${inUse.join(", ")})` : ""}`);
  if (inUse.length) fatal("alterpop.format é usado por regras de coleção — mudar valores mudava o conteúdo dessas coleções. Nada escrito.");

  const rows = await readRows(client);
  const plan = planFormatBackfill(rows, { includeLocked: INCLUDE_LOCKED });
  if (plan.processed !== rows.length) fatal(`processed (${plan.processed}) != lidos (${rows.length})`);

  console.log(`\nACTIVE: ${rows.length} · a escrever: ${plan.sets.length} · a apagar: ${plan.liveToClear.length} · já certos: ${plan.alreadyOk.length} · ficam vazios: ${plan.staysEmpty.length + plan.liveToClear.length} · sem linha no catálogo: ${plan.noCatalogRow.length} · sync_locked de fora: ${plan.lockedSkipped.length}`);
  printCounts("antes (live)", plan.before);
  printCounts("depois (com este --execute)", plan.after);

  const empties = emptiesByVendor(plan);
  console.log(`\nficam vazios (MISSING_FORMAT) — ${plan.staysEmpty.length + plan.liveToClear.length}, por marca:`);
  for (const g of empties) {
    console.log(`  ${g.vendor} — ${g.count}`);
    for (const r of g.rows) console.log(`    ${r.sku}  ${r.handle}  live=${r.liveFormat ?? "—"}${plan.liveToClear.includes(r) ? " → metafieldsDelete" : ""}  "${r.title}"`);
  }
  if (plan.liveToClear.length) {
    console.log(`\n${plan.liveToClear.length} com valor live antigo levam metafieldsDelete em alterpop.format.`);
    console.log(`⚠ risco de título: estes ${plan.liveToClear.length} tinham formato e deixam de ter — na próxima indexação o titleCleaner deixa de tirar o prefixo de formato do título.`);
  }
  for (const r of plan.lockedSkipped) console.log(`  sync_locked, de fora: ${r.sku} ${r.handle} (${r.liveFormat} → ${r.computed})`);
  for (const r of plan.noCatalogRow) console.log(`  sem linha no catálogo: ${r.sku} ${r.handle}`);

  // Guardas 2 e 3.
  if (plan.outsideVocabulary.length) {
    for (const r of plan.outsideVocabulary) console.error(`  fora do vocabulário: ${r.sku} ${r.handle} → ${r.computed}`);
    fatal(`${plan.outsideVocabulary.length} valor(es) calculado(s) fora do vocabulário. Nada escrito.`);
  }
  if (plan.prismaStale.length) {
    for (const r of plan.prismaStale.slice(0, 20)) console.error(`  Prisma=${r.prismaFormat ?? "—"} calculado=${r.computed ?? "—"}  ${r.sku} ${r.handle}`);
    fatal(
      `${plan.prismaStale.length} produto(s) com CatalogProduct.resolvedFormat diferente do vocabulário novo — o indexador ainda não correu com este código. ` +
        `Esperar pelo próximo ciclo do trigger-sync (45 min) e voltar a correr. Nada escrito.`,
    );
  }

  if (!EXECUTE) {
    console.log(`\n[dry-run] a escrever:`);
    for (const r of plan.sets) console.log(`  ${r.sku}  ${r.handle}: ${r.liveFormat ?? "—"} → ${r.computed}`);
    for (const r of plan.liveToClear) console.log(`  ${r.sku}  ${r.handle}: ${r.liveFormat} → (apagado)`);
    reportBatchDone({
      tag: TAG,
      itemsRead: rows.length,
      processed: plan.processed,
      total: rows.length,
      extra: `dry-run, nada escrito · a_escrever=${plan.sets.length} a_apagar=${plan.liveToClear.length} vazios=${plan.staysEmpty.length + plan.liveToClear.length}`,
    });
    return;
  }

  const { written, errors } = await writeMetafieldsBatched(client, plan.sets.map((r) => formatMetafieldInput(r.productId, r.computed)));
  for (const e of errors) console.error(`[${TAG}] ERRO metafieldsSet (${e.productIds.join(", ")}): ${e.message}`);

  // Vazios com valor live antigo: metafieldsDelete, em lotes de 25.
  let cleared = 0;
  for (let i = 0; i < plan.liveToClear.length; i += 25) {
    const chunk = plan.liveToClear.slice(i, i + 25);
    try {
      const data = await client.graphql(METAFIELDS_DELETE, { metafields: chunk.map((r) => formatMetafieldDeleteInput(r.productId)) });
      const ue = data.metafieldsDelete?.userErrors || [];
      if (ue.length) throw new Error(ue.map((e) => e.message).join("; "));
      cleared += (data.metafieldsDelete?.deletedMetafields || []).filter(Boolean).length;
    } catch (err) {
      errors.push({ productIds: chunk.map((r) => r.productId), message: err?.message || String(err) });
      console.error(`[${TAG}] ERRO metafieldsDelete: ${err?.message || err}`);
    }
  }

  const after = planFormatBackfill(await readRows(client), { includeLocked: INCLUDE_LOCKED });
  console.log(`\nreleitura: a escrever=${after.sets.length} a apagar=${after.liveToClear.length} (esperado 0 e 0)`);
  printCounts("live depois", after.before);
  reportBatchDone({
    tag: TAG,
    itemsRead: plan.sets.length + plan.liveToClear.length,
    processed: written + cleared,
    total: plan.sets.length + plan.liveToClear.length,
    errorCount: errors.length + after.sets.length + after.liveToClear.length,
    extra: `escritos=${written} apagados=${cleared}`,
  });
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
