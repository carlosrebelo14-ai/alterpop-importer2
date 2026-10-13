/**
 * Ações em massa só tocam produtos PENDING (Decisão 31, briefing "Preço sem IVA e guarda do
 * tema"): aprovar ou rejeitar em massa nunca altera PUBLISHED, REJECTED, SYNC_ERROR (nem
 * APPROVED, que já está decidido). Um SKU sem entrada na fila conta como PENDING — é o que o
 * painel mostra — e a ação cria a entrada como PENDING e aplica a transição pedida, numa só
 * operação, idempotente (repetir a ação não cria duplicados nem muda o que já foi decidido).
 *
 * Módulo puro: a gravação é de curationQueue.server.js (bulkTransitionPending).
 */

export const BULK_ELIGIBLE_STATUS = "PENDING";

/**
 * Separa os SKUs pedidos em elegíveis (PENDING na fila, ou sem entrada) e ignorados.
 * @param {Array<{ sku: string, status: string }>} items itens da fila
 * @param {string[]} skus
 * @returns {{ eligible: string[], toCreate: string[], skipped: Array<{ sku: string, status: string }> }}
 *   `eligible` inclui `toCreate` (os sem entrada). Ordem de entrada, sem duplicados.
 */
export function partitionBulkEligible(items, skus) {
  const statusBySku = new Map((items || []).map((i) => [i.sku, i.status]));
  const eligible = [];
  const toCreate = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of skus || []) {
    const sku = String(raw ?? "").trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    if (!statusBySku.has(sku)) {
      eligible.push(sku);
      toCreate.push(sku);
    } else if (statusBySku.get(sku) === BULK_ELIGIBLE_STATUS) {
      eligible.push(sku);
    } else {
      skipped.push({ sku, status: statusBySku.get(sku) });
    }
  }
  return { eligible, toCreate, skipped };
}
