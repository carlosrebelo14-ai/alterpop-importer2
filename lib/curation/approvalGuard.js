/**
 * Lote 1, DBG-11 (Decisão 34): um produto PUBLISHED não volta a APPROVED por aprovação manual.
 *
 * Antes, `approveProduct` aceitava PUBLISHED e deixava um item vivo marcado como aprovado pendente.
 * Módulo puro: quem grava a fila é curationQueue.server.js.
 */

export class ApprovePublishedError extends Error {
  /** @param {string} sku */
  constructor(sku) {
    super(`SKU ${sku} já está PUBLISHED na Shopify. Não volta a APPROVED por aprovação manual.`);
    this.name = "ApprovePublishedError";
    this.code = "APPROVE_PUBLISHED";
    this.sku = sku;
  }
}

/**
 * @param {{ sku: string, status?: string } | null | undefined} item Entrada atual (null = SKU nova).
 */
export function assertApprovable(item) {
  if (item?.status === "PUBLISHED") throw new ApprovePublishedError(item.sku);
}
