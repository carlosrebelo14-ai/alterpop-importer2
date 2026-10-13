import { loadCurationQueue } from "./curationQueue.server.js";
import { DECISION_GROUP_IDS, DECISION_GROUP_PREFIX } from "./decisionQueue.js";

/**
 * Motivos como "blocked_brand:FOO" ou "structured_min_price:3<4" trazem um sufixo
 * parametrizado depois de ":" — o filtro compara só a parte antes disso.
 * @param {string} reason
 */
export function reasonBaseToken(reason) {
  return String(reason || "").split(":")[0];
}

/**
 * @param {{ reason?: string, metadata?: { curationReasons?: string[] } }} item
 * @param {string} reasonFilter
 */
export function itemMatchesReason(item, reasonFilter) {
  if (reasonBaseToken(item?.reason) === reasonFilter) return true;
  const extra = item?.metadata?.curationReasons;
  if (Array.isArray(extra)) {
    return extra.some((r) => reasonBaseToken(r) === reasonFilter);
  }
  return false;
}

/**
 * Calcula skuInclude/skuExclude a partir do estado de curadoria e/ou motivo — usado
 * por /api/products, /api/products/export e /api/curation/queue/bulk (approve/reject
 * "Toda a Pesquisa"), que têm de bater sempre certo com a MESMA lógica de filtragem
 * ou o utilizador vê uma contagem diferente do que é realmente processado (bug
 * encontrado 2026-08-13: "Aprovar Toda a Pesquisa" ignorava curationStatus/reason e
 * aprovava um conjunto diferente do mostrado no botão).
 *
 * Decisão 31 — `curationStatus` aceita também um grupo da fila de decisão ("group:ready",
 * "group:manual_price", "group:stale_rule", "group:sync_error"), calculado para a loja
 * (`shop` obrigatório nesse caso). Cruza com o motivo, se vier. Ver decisionQueue.js.
 * @param {string|null} curationStatus
 * @param {string|null} reasonFilter
 * @param {string|null} [shop] só necessário para os grupos da fila de decisão
 * @returns {Promise<{ skuInclude?: string[], skuExclude?: string[] }>}
 */
export async function computeCurationSkuFilter(curationStatus, reasonFilter, shop = null) {
  if (!curationStatus && !reasonFilter) return {};

  const queue = await loadCurationQueue();
  const items = queue.items || [];

  if (typeof curationStatus === "string" && curationStatus.startsWith(DECISION_GROUP_PREFIX)) {
    const id = curationStatus.slice(DECISION_GROUP_PREFIX.length);
    if (!DECISION_GROUP_IDS.includes(id)) throw new Error(`Grupo da fila de decisão inválido: ${id}`);
    if (!shop) throw new Error("Grupo da fila de decisão pedido sem loja");
    const { computeDecisionGroups } = await import("./decisionQueue.server.js");
    let skus = (await computeDecisionGroups(shop)).groups[id] || [];
    if (reasonFilter) {
      const withReason = new Set(items.filter((item) => itemMatchesReason(item, reasonFilter)).map((item) => item.sku));
      skus = skus.filter((sku) => withReason.has(sku));
    }
    return { skuInclude: skus };
  }

  if (curationStatus === "NO_DECISION" && !reasonFilter) {
    return { skuExclude: items.map((item) => item.sku) };
  }

  let filtered = items;
  if (curationStatus && curationStatus !== "NO_DECISION") {
    filtered = filtered.filter((item) => item.status === curationStatus);
  } else if (curationStatus === "NO_DECISION") {
    // NO_DECISION + motivo não faz sentido (sem decisão não tem motivo registado);
    // fica vazio em vez de devolver o catálogo inteiro por engano.
    filtered = [];
  }
  if (reasonFilter) {
    filtered = filtered.filter((item) => itemMatchesReason(item, reasonFilter));
  }
  return { skuInclude: filtered.map((item) => item.sku) };
}
