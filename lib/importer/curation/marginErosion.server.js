/**
 * Alertas de erosão de margem — item 4 do pacote de melhorias criativas de
 * 2026-08-12. Compara o custo (netPrice) guardado no momento da publicação
 * (CurationQueueItem.metadata.costAtPublish, ver curationQueue.server.js) com o
 * custo atual indexado (CatalogProduct.netPrice) para produtos já PUBLISHED.
 *
 * Só reporta — nunca mexe em preço nem stock, como pedido explicitamente na spec.
 */
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../curation/curationQueue.server.js";

export const DEFAULT_MARGIN_EROSION_THRESHOLD_PCT = 15;

/** Limite de SKUs por query IN — evita o limite de parâmetros do SQLite em lojas com
 * muitos produtos publicados (ver precedente em catalogProductsDb.server.js). */
const SKU_CHUNK_SIZE = 500;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {string} shop
 * @param {{ thresholdPct?: number }} [opts]
 * @returns {Promise<{ sku: string, title: string, costAtPublish: number, currentCost: number, erosionPct: number }[]>}
 */
export async function computeMarginErosionAlerts(shop, opts = {}) {
  const thresholdPct = Number.isFinite(opts.thresholdPct)
    ? opts.thresholdPct
    : DEFAULT_MARGIN_EROSION_THRESHOLD_PCT;

  const published = await listCurationQueueItems("PUBLISHED");
  const withBaseline = published.filter(
    (i) => Number.isFinite(i.metadata?.costAtPublish) && i.metadata.costAtPublish > 0
  );
  if (!withBaseline.length) return [];

  const skus = withBaseline.map((i) => i.sku);
  const rowChunks = await Promise.all(
    chunkArray(skus, SKU_CHUNK_SIZE).map((chunk) =>
      safePrisma("marginErosion.currentCosts", () =>
        prisma.catalogProduct.findMany({
          where: { shop, sku: { in: chunk } },
          select: { sku: true, netPrice: true },
        }),
        { rethrow: false, fallback: [] }
      )
    )
  );
  const currentBySku = new Map(rowChunks.flat().map((r) => [r.sku, r.netPrice]));

  const alerts = [];
  for (const item of withBaseline) {
    const currentCost = currentBySku.get(item.sku);
    if (!Number.isFinite(currentCost) || currentCost <= 0) continue;
    const baseline = item.metadata.costAtPublish;
    const erosionPct = ((currentCost - baseline) / baseline) * 100;
    if (erosionPct >= thresholdPct) {
      alerts.push({
        sku: item.sku,
        title: item.title_en || item.sku,
        costAtPublish: baseline,
        currentCost,
        erosionPct: Math.round(erosionPct * 10) / 10,
      });
    }
  }

  alerts.sort((a, b) => b.erosionPct - a.erosionPct);
  return alerts;
}
