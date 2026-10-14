/**
 * Lote 1, DBG-11 (Decisão 34): um produto PUBLISHED não volta a APPROVED por aprovação manual.
 *
 * Antes, `approveProduct` e `bulkSetQueueStatus` aceitavam PUBLISHED e deixavam um item vivo
 * marcado como aprovado pendente. A transição PUBLISHED → PENDING continua permitida: é a que
 * os scripts de revert usam. Módulo puro: quem grava a fila é curationQueue.server.js.
 */

export class ApprovePublishedError extends Error {
  /** @param {string[]} skus */
  constructor(skus) {
    const lista = skus.join(", ");
    super(
      skus.length === 1
        ? `SKU ${lista} já está PUBLISHED na Shopify. Não volta a APPROVED por aprovação manual.`
        : `${skus.length} SKU(s) já estão PUBLISHED na Shopify (${lista}). Nenhum volta a APPROVED por aprovação manual.`
    );
    this.name = "ApprovePublishedError";
    this.code = "APPROVE_PUBLISHED";
    this.skus = skus;
    this.sku = skus[0];
  }
}

/**
 * Recusa a transição para APPROVED de qualquer item já PUBLISHED. Não toca em nada.
 * @param {Array<{ sku: string, status?: string } | null | undefined>} items Itens que a operação vai tocar.
 * @param {string} targetStatus
 */
export function assertTransitionAllowed(items, targetStatus) {
  if (targetStatus !== "APPROVED") return;
  const published = items.filter((i) => i?.status === "PUBLISHED").map((i) => i.sku);
  if (published.length) throw new ApprovePublishedError(published);
}

/**
 * @param {{ sku: string, status?: string } | null | undefined} item Entrada atual (null = SKU nova).
 */
export function assertApprovable(item) {
  assertTransitionAllowed(item ? [item] : [], "APPROVED");
}
