/**
 * Migração dos produtos apagados no admin (decisão do Carlos, 09/10/2026): os que o ciclo de
 * stock não encontrava na loja (SyncErrorLog "Produto/variante não encontrado na Shopify") e
 * que estão REJECTED na fila voltam a PENDING, com a nota "apagado no admin" e a data. Só
 * se mexe em quem tem prova de que o produto não existe; o resto fica à vista com a razão.
 * Módulo puro: o script lê o log, a fila e a loja.
 *
 * @typedef {{ sku: string, action: 'MIGRATE'|'KEEP', reason: string, status: string|null, proof: string|null }} MigrationRow
 */

/** Estados de origem que a migração aceita: nunca toca em APPROVED nem PUBLISHED. */
export const MIGRATABLE_FROM = Object.freeze(["REJECTED", "SYNC_ERROR"]);

/**
 * @param {{
 *   logSkus: string[],
 *   itemBySku: Map<string, { sku: string, status: string, metadata?: { shopifyProductId?: string|null } }>,
 *   liveSkus: Set<string>,
 *   productExists: Map<string, boolean|null>,
 * }} args productExists: por SKU, o resultado de product(id) do id guardado (false = não existe,
 *   true = existe, null = não foi possível ler); ausente = sem id guardado.
 * @returns {MigrationRow[]}
 */
export function planDeletedMigration({ logSkus, itemBySku, liveSkus, productExists }) {
  return [...new Set(logSkus)].sort().map((sku) => {
    const item = itemBySku.get(sku);
    const keep = (reason, status = item?.status ?? null) => ({ sku, action: "KEEP", reason, status, proof: null });
    if (!item) return keep("SKU fora da fila");
    if (item.status === "PENDING") return keep("já está PENDING");
    if (!MIGRATABLE_FROM.includes(item.status)) return keep(`estado ${item.status} — a migração só toca em ${MIGRATABLE_FROM.join(" e ")}`);
    if (liveSkus.has(sku)) return keep("existe uma variante na loja com este SKU — não está apagado");
    const exists = productExists.get(sku);
    if (exists === true) return keep("o produto guardado ainda existe na loja (com outro SKU)");
    if (exists === null) return keep("não foi possível ler o produto guardado — existência por provar");
    return {
      sku,
      action: "MIGRATE",
      reason: "apagado no admin",
      status: item.status,
      proof: exists === false ? "sem variante com o SKU e product(id) inexistente" : "sem variante com o SKU (sem id de produto guardado)",
    };
  });
}
