/**
 * Fila de decisão — cálculo dos quatro grupos sobre a fila, o catálogo e a loja
 * (classificação pura em decisionQueue.js). Uma passagem pelo catálogo indexado da loja e
 * uma leitura da fila; os preços live só dos PUBLISHED, em lote, com a cache curta do painel.
 *
 * Falha de leitura da loja NÃO lança: o grupo "Regra desatualizada" fica vazio e `liveError`
 * diz porquê (o painel mostra-o) — nunca "0 desatualizados" em silêncio.
 */
import { prisma, findManyConfirmed } from "../prisma/prismaSafe.server.js";
import { computeDataConfidenceScore } from "../importer/curation/dataConfidenceScore.js";
import { evaluatePrice, resolveMarginPct } from "../importer/pricing/pricing.server.js";
import { compareLivePrice } from "../importer/pricing/livePrice.js";
import { loadShopSettings } from "../importer/settings.server.js";
import { loadLivePricesForPanel } from "../importer/shopify/livePricePanel.server.js";
import { loadCurationQueue } from "./curationQueue.server.js";
import { DECISION_GROUP_IDS, decisionGroup, hasManualPrice, rowWarnings } from "./decisionQueue.js";

const TTL_MS = 20_000;
/** @type {Map<string, { at: number, value: object }>} */
const cache = new Map();

export function clearDecisionGroupsCache() {
  cache.clear();
}

async function defaultLoadCatalogRows(shop) {
  return findManyConfirmed(prisma.catalogProduct, {
    where: { shop },
    select: { sku: true, distributorPrice: true, grossPrice: true, titleSource: true, categoryMain: true, dimensions: true, weightKg: true, hsCode: true },
  });
}

/**
 * @param {string} shop
 * @param {{ loadQueue?: Function, loadCatalogRows?: Function, loadLive?: Function, marginPct?: number,
 *   rule?: 'NET'|'LEGACY', noCache?: boolean, now?: number }} [deps] injeção para testes
 * @returns {Promise<{ groups: Record<string, string[]>, counts: Record<string, number>, liveError: string|null, computedAt: string }>}
 */
export async function computeDecisionGroups(shop, deps = {}) {
  const now = deps.now ?? Date.now();
  const hit = cache.get(shop);
  if (!deps.noCache && hit && now - hit.at < TTL_MS) return /** @type {any} */ (hit.value);

  const queue = await (deps.loadQueue || loadCurationQueue)();
  const itemBySku = new Map(queue.items.map((i) => [i.sku, i]));
  const rows = await (deps.loadCatalogRows || defaultLoadCatalogRows)(shop);
  const marginPct = deps.marginPct ?? resolveMarginPct(await loadShopSettings(shop));

  /** @type {Record<string, string[]>} */
  const groups = Object.fromEntries(DECISION_GROUP_IDS.map((g) => [g, []]));
  const published = [];
  const priced = new Map();
  const inCatalog = new Set();

  for (const r of rows) {
    inCatalog.add(r.sku);
    const item = itemBySku.get(r.sku);
    const status = item?.status ?? null;
    const p = evaluatePrice(r.distributorPrice, r.grossPrice, marginPct, item, deps.rule ? { rule: deps.rule } : undefined);
    const manualPrice = hasManualPrice(item);
    const warnings = rowWarnings({ priceError: p.priceError, confidenceLevel: computeDataConfidenceScore(r).level });
    if (status === "PUBLISHED") {
      published.push(r.sku);
      priced.set(r.sku, { p, manualPrice });
      continue; // grupo decidido depois de ler os preços live
    }
    const g = decisionGroup({ status, manualPrice, warnings });
    if (g) groups[g].push(r.sku);
  }

  // Itens da fila fora do catálogo (saíram do feed): só os erros de sincronização e os de
  // preço manual contam — não há dados de preço para os outros grupos.
  for (const item of queue.items) {
    if (inCatalog.has(item.sku)) continue;
    const g = decisionGroup({ status: item.status, manualPrice: hasManualPrice(item), warnings: ["not_in_catalog"] });
    if (g === "sync_error" || g === "manual_price") groups[g].push(item.sku);
  }

  let liveError = null;
  if (published.length) {
    const { bySku, error } = await (deps.loadLive || ((skus) => loadLivePricesForPanel(shop, skus)))(published);
    liveError = error || null;
    for (const sku of published) {
      const { p, manualPrice } = priced.get(sku);
      const live = compareLivePrice({ queueStatus: "PUBLISHED", finalPrice: p.finalPrice, cost: p.cost, live: bySku.get(sku), readError: error });
      const g = decisionGroup({ status: "PUBLISHED", manualPrice, liveState: live.liveState });
      if (g) groups[g].push(sku);
    }
  }

  const counts = Object.fromEntries(DECISION_GROUP_IDS.map((g) => [g, groups[g].length]));
  const value = { groups, counts, liveError, computedAt: new Date(now).toISOString() };
  if (!deps.noCache) cache.set(shop, { at: now, value });
  return value;
}
