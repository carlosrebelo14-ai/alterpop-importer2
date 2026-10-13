/**
 * Histórico de preços enviados à Shopify (Decisão 31) — tabela PriceHistory.
 * Gravado por recordLastPriceWrites (curationQueue.server.js), o ponto por onde passam o
 * publisher, "Aplicar aos publicados", a página Import e a reconciliação — e que
 * scripts/tests/price-write-records.test.js já obriga todo o escritor de preço a chamar.
 */
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { currentPriceRule, ruleOfRecord } from "./priceMode.js";
import { omnibusMinCents } from "./omnibus.js";

const SKU_CHUNK = 500;

/** Origens que não são uma escrita datada: o backfill infere um preço que já estava na loja. */
const NOT_A_DATED_WRITE = new Set(["backfill"]);

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Loja do histórico quando o chamador não a passa: a loja configurada para o sync.
 * @returns {string|null}
 */
export function defaultHistoryShop() {
  return process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || null;
}

/**
 * Linhas de histórico a partir de registos de última escrita (buildLastPriceWrite).
 * @param {Array<{ sku: string, write: { price: number, rule?: string, source: string, at: string } }>} entries
 * @param {string} shop
 */
export function historyRowsFromWrites(entries, shop) {
  const rows = [];
  for (const { sku, write } of entries) {
    if (!write || NOT_A_DATED_WRITE.has(write.source)) continue;
    const priceCents = Math.round(Number(write.price) * 100);
    if (!Number.isInteger(priceCents) || priceCents <= 0) {
      throw new Error(`Histórico de preço: preço inválido para ${sku} (${write.price})`);
    }
    rows.push({ shop, sku, priceCents, rule: ruleOfRecord(write), source: write.source, at: new Date(write.at) });
  }
  return rows;
}

/**
 * Grava o histórico. Lança em erro de escrita: o chamador (recordLastPriceWrites) decide —
 * o preço já está na Shopify, por isso a falha é registada e devolvida, não desfeita.
 * @param {Array<{ sku: string, write: object }>} entries
 * @param {{ shop?: string|null }} [opts]
 * @returns {Promise<{ recorded: number }>}
 */
export async function recordPriceHistory(entries, opts = {}) {
  const shop = opts.shop || defaultHistoryShop();
  const toWrite = (entries || []).filter((e) => e?.write && !NOT_A_DATED_WRITE.has(e.write.source));
  if (!toWrite.length) return { recorded: 0 };
  if (!shop) throw new Error("Histórico de preço: loja não resolvida (passa shop ou define SHOPIFY_SHOP_URL)");
  const rows = historyRowsFromWrites(toWrite, shop);
  await safePrisma("priceHistory.createMany", () => prisma.priceHistory.createMany({ data: rows }), { rethrow: true });
  return { recorded: rows.length };
}

/**
 * Mínimo Omnibus (cêntimos) por SKU, só com entradas da regra pedida. SKUs sem histórico
 * dessa regra ficam fora do mapa. Leitura confirmada: erro lança (nunca "sem histórico").
 * @param {string} shop
 * @param {string[]} skus
 * @param {{ rule?: "NET"|"LEGACY", now?: Date }} [opts]
 * @returns {Promise<Map<string, number>>}
 */
export async function getOmnibusMinBySkus(shop, skus, opts = {}) {
  const rule = opts.rule || currentPriceRule();
  const now = opts.now || new Date();
  const result = new Map();
  const unique = [...new Set((skus || []).filter(Boolean))];
  for (const chunk of chunkArray(unique, SKU_CHUNK)) {
    const rows = await safePrisma(
      "priceHistory.findMany",
      () =>
        prisma.priceHistory.findMany({
          where: { shop, rule, sku: { in: chunk } },
          select: { sku: true, priceCents: true, rule: true, at: true },
        }),
      { rethrow: true }
    );
    const bySku = new Map();
    for (const r of rows) {
      if (!bySku.has(r.sku)) bySku.set(r.sku, []);
      bySku.get(r.sku).push(r);
    }
    for (const [sku, list] of bySku) {
      const min = omnibusMinCents(list, now, rule);
      if (min != null) result.set(sku, min);
    }
  }
  return result;
}
