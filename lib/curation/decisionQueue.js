/**
 * Fila de decisão (Decisão 31, briefing "Preço sem IVA e guarda do tema"): agrupa o trabalho
 * que espera o Carlos em quatro grupos. Módulo puro, sem I/O: o cálculo sobre a fila, o
 * catálogo e a loja está em decisionQueue.server.js.
 *
 *   ready         Prontos a aprovar        PENDING (ou sem entrada na fila) sem avisos
 *   manual_price  Preço manual             produto com preço manual ativo (overrides.price)
 *   stale_rule    Regra desatualizada      PUBLISHED com o selo "Regra" (preço da loja ≠ regra)
 *   sync_error    Erros de sincronização   SYNC_ERROR
 *
 * Avisos (preço por calcular, dados de baixa confiança) tiram o produto de "Prontos a
 * aprovar" mas NUNCA bloqueiam a aprovação: continua aprovável pela lista normal. Stock não
 * conta: um produto esgotado é aprovável e aparece com o selo "Esgotado".
 * Prioridade quando um produto cabia em mais de um grupo: erro de sincronização, preço
 * manual, regra desatualizada, pronto a aprovar.
 */

export const DECISION_GROUPS = Object.freeze({
  READY: "ready",
  MANUAL_PRICE: "manual_price",
  STALE_RULE: "stale_rule",
  SYNC_ERROR: "sync_error",
});

export const DECISION_GROUP_LABELS = Object.freeze({
  ready: "Prontos a aprovar",
  manual_price: "Preço manual",
  stale_rule: "Regra desatualizada",
  sync_error: "Erros de sincronização",
});

export const DECISION_GROUP_IDS = Object.freeze(Object.values(DECISION_GROUPS));

/** O filtro de estado do painel aceita "group:<id>" além dos estados da fila. */
export const DECISION_GROUP_PREFIX = "group:";

export const WARNING_CODES = Object.freeze({ PRICE_ERROR: "price_error", LOW_CONFIDENCE: "low_confidence" });

/**
 * Preço manual ativo: override de preço fixado na curadoria.
 * @param {{ metadata?: { overrides?: { price?: number|string|null } } }|null|undefined} item
 */
export function hasManualPrice(item) {
  return Number(item?.metadata?.overrides?.price) > 0;
}

/**
 * Avisos de uma linha. Só informam.
 * @param {{ priceError?: string|null, confidenceLevel?: string|null }} row
 * @returns {string[]}
 */
export function rowWarnings({ priceError, confidenceLevel }) {
  const out = [];
  if (priceError) out.push(WARNING_CODES.PRICE_ERROR);
  if (confidenceLevel === "low") out.push(WARNING_CODES.LOW_CONFIDENCE);
  return out;
}

/**
 * @param {{ status?: string|null, manualPrice?: boolean, liveState?: string|null, warnings?: string[] }} row
 *   status vazio = sem entrada na fila = PENDING
 * @returns {"ready"|"manual_price"|"stale_rule"|"sync_error"|null} null = não está em nenhum grupo
 */
export function decisionGroup({ status, manualPrice = false, liveState = null, warnings = [] }) {
  const st = status || "PENDING";
  if (st === "SYNC_ERROR") return DECISION_GROUPS.SYNC_ERROR;
  if (st === "REJECTED") return null;
  if (manualPrice) return DECISION_GROUPS.MANUAL_PRICE;
  if (st === "PUBLISHED") return liveState === "differs" ? DECISION_GROUPS.STALE_RULE : null;
  if (st === "PENDING" && warnings.length === 0) return DECISION_GROUPS.READY;
  return null;
}
