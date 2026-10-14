/**
 * Lote 1, DBG-03 (Decisão 34): só se publica o que está APPROVED.
 *
 * Um pedido com SKUs fora de APPROVED é recusado por inteiro, com a lista de SKUs e estados.
 * Não há fallback. Antes, um SKU pedido em PENDING ou REJECTED ia para a Shopify sem aprovação.
 * Módulo puro, sem I/O: quem chama lê a fila e passa `statusBySku`.
 */

/**
 * @param {object} input
 * @param {string[] | null | undefined} input.requested SKUs pedidos. Vazio ou ausente = todos os APPROVED.
 * @param {string[]} input.approved SKUs em APPROVED, pela ordem da fila.
 * @param {Map<string, string>} [input.statusBySku] Estado atual de cada SKU da fila.
 * @returns {{ ok: true, skus: string[] } | { ok: false, error: string, rejected: Array<{ sku: string, status: string | null }> }}
 */
export function resolveSyncSkus({ requested, approved, statusBySku = new Map() }) {
  const approvedUnique = [...new Set(approved)];
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: true, skus: approvedUnique };
  }

  const approvedSet = new Set(approvedUnique);
  const wanted = [...new Set(requested)];
  const rejected = wanted
    .filter((sku) => !approvedSet.has(sku))
    .map((sku) => ({ sku, status: statusBySku.get(sku) ?? null }));

  if (rejected.length) {
    const lista = rejected.map((r) => `${r.sku} (${r.status ?? "sem entrada na fila"})`).join(", ");
    return {
      ok: false,
      error: `${rejected.length} SKU(s) pedidos não estão APPROVED: ${lista}. Nada foi publicado.`,
      rejected,
    };
  }

  const wantedSet = new Set(wanted);
  return { ok: true, skus: approvedUnique.filter((sku) => wantedSet.has(sku)) };
}
