/**
 * Junta todas as páginas de uma pesquisa e verifica que somam o total que a base reporta.
 *
 * Antes, «Aprovar Toda a Pesquisa (13 016)» chamava uma só página de 10 000 («limite de
 * segurança») e aprovava 10 000 produtos enquanto dizia 13 016 — em silêncio (09/10/2026, visto
 * pelo modal do D1). Agora percorre todas as páginas; se o número de SKUs distintos não bater
 * com o total, lança: uma ação em massa nunca se aplica a um subconjunto sem o dizer.
 *
 * @param {(page: number) => Promise<{ skus: string[], totalCount: number }>} fetchPage páginas de 1 em diante
 * @param {{ maxPages?: number }} [opts] teto de páginas (contra um ciclo infinito), não de produtos
 * @returns {Promise<{ skus: string[], totalCount: number }>}
 */
export async function collectAllPages(fetchPage, { maxPages = 1000 } = {}) {
  const seen = new Set();
  let totalCount = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetchPage(page);
    totalCount = res.totalCount;
    for (const sku of res.skus) seen.add(sku);
    // Fim: já temos o total, ou a página veio vazia.
    if (seen.size >= totalCount || res.skus.length === 0) break;
  }
  if (seen.size !== totalCount) {
    throw new Error(
      `Contagem inconsistente: a pesquisa tem ${totalCount} produtos mas só foi possível ler ${seen.size}. Nada foi alterado — volta a tentar (a indexação pode estar a mudar o catálogo).`
    );
  }
  return { skus: [...seen], totalCount };
}
