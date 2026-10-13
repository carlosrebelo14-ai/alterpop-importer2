/**
 * Observações manuais de preço de mercado (Decisão 31) — tabela MarketPriceObservation.
 * Validação e vistas em marketPrice.js (puro).
 */
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { parseMarketObservation, latestObservationBySku, marketView, MarketPriceError } from "./marketPrice.js";

const SKU_CHUNK = 500;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Grava uma observação. SKU fora do catálogo indexado da loja é recusado (MarketPriceError,
 * code NOT_FOUND). Escrita lança em erro: nunca "gravado" em silêncio.
 * @param {string} shop
 * @param {unknown} body ver parseMarketObservation
 * @param {{ createdBy?: string|null, now?: Date }} [opts]
 */
export async function recordMarketObservation(shop, body, opts = {}) {
  const obs = parseMarketObservation(body, opts.now);
  const exists = await safePrisma(
    "marketPrice.skuExists",
    () => prisma.catalogProduct.findUnique({ where: { shop_sku: { shop, sku: obs.sku } }, select: { sku: true } }),
    { rethrow: true }
  );
  if (!exists) {
    const err = new MarketPriceError(`SKU ${obs.sku} não existe no catálogo indexado desta loja`);
    /** @type {any} */ (err).code = "NOT_FOUND";
    throw err;
  }
  const row = await safePrisma(
    "marketPrice.create",
    () =>
      prisma.marketPriceObservation.create({
        data: { shop, sku: obs.sku, priceCents: obs.priceCents, store: obs.store, observedAt: obs.observedAt, createdBy: opts.createdBy || null },
      }),
    { rethrow: true }
  );
  return { id: row.id, sku: obs.sku, ...marketView(row) };
}

/**
 * Observação mais recente por SKU, uma consulta por bloco de SKUs (nunca uma por linha).
 * Leitura confirmada: erro lança.
 * @param {string} shop
 * @param {string[]} skus
 */
export async function getLatestMarketBySkus(shop, skus) {
  const unique = [...new Set((skus || []).filter(Boolean))];
  const rows = [];
  for (const chunk of chunkArray(unique, SKU_CHUNK)) {
    rows.push(
      ...(await safePrisma(
        "marketPrice.findMany",
        () =>
          prisma.marketPriceObservation.findMany({
            where: { shop, sku: { in: chunk } },
            select: { sku: true, priceCents: true, store: true, observedAt: true, createdAt: true },
          }),
        { rethrow: true }
      ))
    );
  }
  return latestObservationBySku(rows);
}

export { MarketPriceError };
