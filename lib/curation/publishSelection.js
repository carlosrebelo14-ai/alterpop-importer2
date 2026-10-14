/**
 * Lote 1, DBG-03 (Decisão 34), lado do painel: a seleção que vai para a Shopify só tem SKUs APPROVED.
 * O resto fica de fora e o painel diz quantos e porquê. O servidor recusa com 400 de qualquer forma.
 * Módulo puro: o painel passa `decisions` (SKU → estado), que é o que o loader já devolve.
 */

const SEM_DECISAO = "sem decisão";

/**
 * @param {string[]} selectedSkus Seleção do operador, pela ordem da grelha.
 * @param {Record<string, string | undefined>} decisions Estado atual de cada SKU. Sem entrada = sem decisão.
 * @returns {{ publish: string[], leftOut: Record<string, number>, leftOutCount: number }}
 */
export function partitionPublishSelection(selectedSkus, decisions) {
  const publish = [];
  /** @type {Record<string, number>} */
  const leftOut = {};
  for (const sku of selectedSkus) {
    const status = decisions[sku];
    if (status === "APPROVED") {
      publish.push(sku);
    } else {
      const motivo = status || SEM_DECISAO;
      leftOut[motivo] = (leftOut[motivo] || 0) + 1;
    }
  }
  return { publish, leftOut, leftOutCount: selectedSkus.length - publish.length };
}

/**
 * Texto curto para o painel: "2 PENDING, 1 PUBLISHED". Vazio se não ficou ninguém de fora.
 * @param {Record<string, number>} leftOut
 */
export function describeLeftOut(leftOut) {
  return Object.entries(leftOut)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
}
