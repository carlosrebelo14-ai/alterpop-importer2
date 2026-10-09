import { loadOfflineSessionForShop } from "../../session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../shopifyClient.js";
import { fetchLiveVariantsBySku } from "./liveVariantsBySku.server.js";

/**
 * Preço live dos SKUs PUBLISHED de uma página do painel (A3). Só leitura, em lote, só
 * para os SKUs pedidos. Cache curta por SKU: a Curadoria repete pesquisas ao escrever e
 * não pode fazer uma ida à Shopify por pesquisa. Falha de leitura NÃO lança: devolve
 * `error`, e o painel mostra "live não lido" em vez de esconder o problema.
 */
const TTL_MS = 60_000;
/** @type {Map<string, { at: number, live: object|null }>} */
const cache = new Map();

export function clearLivePriceCache() {
  cache.clear();
}

/**
 * @param {string} shop
 * @param {string[]} skus
 * @param {{ fetchLive?: (skus: string[]) => Promise<Map<string, object>>, now?: number }} [deps] injeção para testes
 * @returns {Promise<{ bySku: Map<string, { price: number }|null>, error: string|null }>}
 */
export async function loadLivePricesForPanel(shop, skus, deps = {}) {
  const now = deps.now ?? Date.now();
  /** @type {Map<string, { price: number }|null>} */
  const bySku = new Map();
  const stale = [];
  for (const sku of skus) {
    const hit = cache.get(`${shop}::${sku}`);
    if (hit && now - hit.at < TTL_MS) bySku.set(sku, hit.live);
    else stale.push(sku);
  }
  if (!stale.length) return { bySku, error: null };

  try {
    let fetchLive = deps.fetchLive;
    if (!fetchLive) {
      const client = createShopifyClientFromSession(await loadOfflineSessionForShop(shop));
      fetchLive = (list) => fetchLiveVariantsBySku(client, list);
    }
    const live = await fetchLive(stale);
    for (const sku of stale) {
      const v = live.get(sku) || null;
      cache.set(`${shop}::${sku}`, { at: now, live: v });
      bySku.set(sku, v);
    }
    return { bySku, error: null };
  } catch (err) {
    return { bySku, error: `Preço live não lido: ${err?.message || err}` };
  }
}
