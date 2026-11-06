/**
 * Contagem de TODOS os estados da fila para o painel (D4, briefing 06/11/2026). A soma dos estados mais
 * `semRegisto` (produto da base sem item na fila) é sempre igual a `totalIndexed`.
 * Itens da fila cujo SKU já não está na base ficam fora, como antes, e vão para `foraDaBase`.
 * @param {{ sku: string, status: string }[]} items
 * @param {Set<string>} catalogSkuSet
 * @param {number} totalIndexed
 */
export function countQueueStates(items, catalogSkuSet, totalIndexed) {
  const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0, PUBLISHED: 0, SYNC_ERROR: 0 };
  let outros = 0;
  let foraDaBase = 0;
  let naBase = 0;
  for (const item of items || []) {
    if (!catalogSkuSet.has(item.sku)) {
      foraDaBase += 1;
      continue;
    }
    naBase += 1;
    if (item.status in counts) counts[item.status] += 1;
    else outros += 1;
  }
  const classificados = counts.PENDING + counts.APPROVED + counts.REJECTED + counts.PUBLISHED + counts.SYNC_ERROR + outros;
  const semRegisto = Math.max(0, totalIndexed - classificados);
  return {
    totalPending: counts.PENDING,
    totalApproved: counts.APPROVED,
    totalRejected: counts.REJECTED,
    totalPublished: counts.PUBLISHED,
    totalQueueSyncError: counts.SYNC_ERROR,
    totalOtherStates: outros,
    withoutRecord: semRegisto,
    outsideCatalog: foraDaBase,
    stateSum: classificados + semRegisto,
  };
}
