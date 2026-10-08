#!/usr/bin/env node
/**
 * Dry-run da passagem dos produtos PUBLISHED à regra de preço (pricing.server.js) —
 * briefing "Preço com margem e teto de mercado" + revisão do dry-run (07/10/2026).
 * SÓ LEITURA: não escreve nada na Shopify nem na base de dados. PARAR depois disto — a
 * aplicação (price-reconcile-apply.js) espera o OK do Carlos sobre a lista.
 *
 * Custo e PVPR vêm do FEED FRESCO (precio_distribuidores, precio_bruto), não do
 * catálogo: corre antes do deploy que acrescenta CatalogProduct.distributorPrice. O
 * mesmo passeio pelo feed dá a contagem de nulos.
 *
 * Classificação (muda / igual / manual / override / sync_locked / sem dados) em
 * lib/importer/pricing/priceReconcile.server.js — a mesma da aplicação. Os PUBLISHED
 * sem variante live saem com a causa (produto apagado e quando, ou SKU mudado).
 *
 * Saída: resumo no terminal (por categoria e por estado de preço) +
 * results/price-reconcile-dry-run-<data>.csv com todas as linhas.
 *
 * Margem: a gravada nas definições da loja, ou PRICE_MARGIN_PCT=NN para simular outra.
 *
 * Corre na Fly:
 *   node scripts/catalog/price-reconcile-dry-run.js
 *   env PRICE_MARGIN_PCT=35 node scripts/catalog/price-reconcile-dry-run.js
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { streamOcioStockRows } from "../../lib/importer/connectors/ociostock/streamCsv.js";
import { resolveMarginPct, assertMarginPct, effectiveMarginPct, PRICE_STATUS } from "../../lib/importer/pricing/pricing.server.js";
import {
  classifyPriceReconcile,
  toReconcileRow,
  reconcileRowsToCsv,
  printReconcileSummary,
} from "../../lib/importer/pricing/priceReconcile.server.js";
import { fetchLiveVariantsBySku, diagnoseMissingLive } from "../../lib/importer/shopify/liveVariantsBySku.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

function parseFeedPrice(value) {
  const n = parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Passeio único pelo feed: preços dos SKUs publicados + contagem de nulos do feed todo.
 * @param {Set<string>} wanted
 */
async function readFeedPrices(wanted) {
  const bySku = new Map();
  const counts = { rows: 0, distNull: 0, pvprNull: 0 };
  await streamOcioStockRows({
    onRow: async (row) => {
      counts.rows += 1;
      const dist = parseFeedPrice(row.precio_distribuidores);
      const pvpr = parseFeedPrice(row.precio_bruto);
      if (dist == null) counts.distNull += 1;
      if (pvpr == null) counts.pvprNull += 1;
      const sku = String(row.referencia || "").trim();
      if (wanted.has(sku)) bySku.set(sku, { distributorPrice: dist, grossPrice: pvpr });
    },
  });
  return { bySku, counts };
}

async function main() {
  console.log(`=== price-reconcile-dry-run (${SHOP}) · SÓ LEITURA ===\n`);

  const settings = await loadShopSettings(SHOP);
  const marginPct = process.env.PRICE_MARGIN_PCT
    ? assertMarginPct(process.env.PRICE_MARGIN_PCT)
    : resolveMarginPct(settings);
  console.log(`Margem global: ${marginPct}%${process.env.PRICE_MARGIN_PCT ? " (simulada via PRICE_MARGIN_PCT)" : ""}${effectiveMarginPct(marginPct) !== marginPct ? ` — abaixo do mínimo, aplica-se ${effectiveMarginPct(marginPct)}%` : ""}`);

  // O feed lê-se pelo mesmo caminho do indexador: OCIOSTOCK_CSV_URL, ou o URL das definições.
  if (settings.ociostockCsvUrl && !process.env.OCIOSTOCK_CSV_PATH) {
    process.env.OCIOSTOCK_CSV_URL = settings.ociostockCsvUrl;
  }

  const published = (await listCurationQueueItems("PUBLISHED")).filter((i) => i.sku);
  const skus = published.map((i) => i.sku);
  console.log(`PUBLISHED na fila: ${skus.length}`);

  console.log("A ler o feed fresco…");
  const { bySku: feedBySku, counts } = await readFeedPrices(new Set(skus));
  console.log(
    `Feed: ${counts.rows} linhas · sem precio_distribuidores: ${counts.distNull} · sem precio_bruto: ${counts.pvprNull}`
  );
  const pubDistNull = skus.filter((s) => feedBySku.has(s) && feedBySku.get(s).distributorPrice == null).length;
  console.log(`Publicados no feed: ${feedBySku.size} de ${skus.length} · desses sem precio_distribuidores: ${pubDistNull}`);

  const catalogRows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, sku: { in: skus } },
    select: { sku: true, title: true, netPrice: true },
  });
  const catalogBySku = new Map(catalogRows.map((r) => [r.sku, r]));

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const liveBySku = await fetchLiveVariantsBySku(client, skus);
  const missingLiveReasons = await diagnoseMissingLive(
    client,
    published.filter((i) => !liveBySku.has(i.sku))
  );
  console.log(`Em CatalogProduct: ${catalogRows.length} · variantes live: ${liveBySku.size}\n`);

  const rows = published.map((item) => {
    const cat = catalogBySku.get(item.sku);
    const live = liveBySku.get(item.sku);
    const result = classifyPriceReconcile({
      item,
      prices: feedBySku.get(item.sku) || null,
      netPrice: cat?.netPrice,
      live,
      missingLiveReason: missingLiveReasons.get(item.sku),
      marginPct,
    });
    return toReconcileRow({ sku: item.sku, title: cat?.title || live?.title, live, result });
  });

  printReconcileSummary(rows, Object.values(PRICE_STATUS));

  const outDir = path.join(process.cwd(), "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `price-reconcile-dry-run-${new Date().toISOString().slice(0, 10)}.csv`);
  fs.writeFileSync(outFile, reconcileRowsToCsv(rows));
  console.log(`\nLista completa: ${outFile}`);
  console.log("Nada foi escrito na Shopify. PARAR — aplicar só depois do OK do Carlos.");
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
