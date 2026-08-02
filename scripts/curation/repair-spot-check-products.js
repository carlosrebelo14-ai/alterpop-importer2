#!/usr/bin/env node
/**
 * Completa variantes / preço / metafield / imagens dos produtos do spot-check live
 * criados antes do fix de ProductVariantsBulkInput (SKU em inventoryItem).
 */
import prisma from "../../app/db.server.js";
import { mapOcioStockRow } from "../../lib/importer/connectors/ociostock/csvFieldMap.js";
import { streamOcioStockRows } from "../../lib/importer/connectors/ociostock/streamCsv.js";
import { transformOcioStockRecord } from "../../lib/importer/core/transformRow.js";
import { resolveProductStatus } from "../../lib/importer/curation/index.js";
import { ImportJob } from "../../lib/importer/jobs/ImportJob.js";
import { ProductImporter } from "../../lib/importer/importers/ProductImporter.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const TARGETS = [
  {
    productId: "gid://shopify/Product/15930912047486",
    sku: "889698486569",
    synthetic: false,
  },
  {
    productId: "gid://shopify/Product/15930912080254",
    sku: "889698486569-spot-priority",
    synthetic: true,
    baseSku: "889698486569",
  },
];

async function loadRecordForSku(sku, syntheticFrom) {
  let found = null;
  await streamOcioStockRows({
    shouldStop: () => Boolean(found),
    onRow: async (row) => {
      const mapped = mapOcioStockRow(row);
      if (!mapped || mapped.sku !== (syntheticFrom || sku)) return;
      transformOcioStockRecord(mapped, null);
      found = mapped;
      if (syntheticFrom) {
        found = structuredClone(mapped);
        found.sku = sku;
        found.title = `${found.title} — One Piece`;
        found.franchises = [...new Set([...(found.franchises || []), "onepiece", "One Piece"])];
      }
    },
  });
  return found;
}

async function main() {
  const session = await prisma.session.findFirst({
    where: { shop: "alterpop-store.myshopify.com" },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) throw new Error("Sem sessão Shopify");

  const client = createShopifyClientFromSession(session);
  const job = new ImportJob({
    jobId: `spot-check-repair-${Date.now()}`,
    dryRun: false,
    importMode: "CREATE_AND_UPDATE",
  });
  await job.ensureResultsDir();

  const importer = new ProductImporter(job, client, {
    syncImages: true,
    syncPrices: true,
    importMode: "CREATE_AND_UPDATE",
  });
  await importer.prepare();

  for (const target of TARGETS) {
    const record = await loadRecordForSku(target.sku, target.synthetic ? target.baseSku : null);
    if (!record) throw new Error(`SKU ${target.sku} não encontrado no CSV`);

    const { status, reasons } = await resolveProductStatus(record);
    record._shopifyStatus = status;
    record._curationReasons = reasons;

    const variantQuery = await client.graphql(
      `query ($id: ID!) {
        product(id: $id) {
          id
          title
          variants(first: 1) {
            nodes { id sku inventoryItem { id } }
          }
        }
      }`,
      { id: target.productId }
    );

    const product = variantQuery.product;
    const variantNode = product?.variants?.nodes?.[0];
    if (!variantNode?.id) throw new Error(`Sem variante em ${target.productId}`);

    importer.variantCache.set(record.sku, {
      id: variantNode.id,
      sku: record.sku,
      product: { id: product.id, title: product.title },
      inventoryItem: variantNode.inventoryItem?.id
        ? { id: variantNode.inventoryItem.id }
        : null,
    });

    console.log(`\n▶ Reparar ${record.sku} (${status}) → ${target.productId}`);
    await importer.updateProduct(record, importer.variantCache.get(record.sku), record.categoryMain);
    console.log(`✓ ${record.sku} completo`);
  }

  await job.finalize("completed");
  console.log(`\nResultados: results/${job.jobId}/`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
