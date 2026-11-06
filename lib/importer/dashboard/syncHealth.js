/**
 * Shopify Sync Health (D3, briefing 06/11/2026). Fórmula única: 1 − erros ativos / produtos PUBLISHED.
 * Os erros ativos vêm da mesma fonte do banner da Curadoria (SKUs distintos com SyncErrorLog ativo).
 * Sem produtos publicados não há medição: devolve `rate: null` e o painel mostra o texto, nunca 100%.
 * Os erros são limitados ao total de publicados, para o valor ficar entre 0 e 1.
 * @param {{ published: number, activeErrors: number }} p
 * @returns {{ rate: number | null, published: number, activeErrors: number, label: string }}
 */
export function computeSyncHealth({ published, activeErrors }) {
  const total = Math.max(0, Math.floor(Number(published) || 0));
  const errors = Math.max(0, Math.floor(Number(activeErrors) || 0));
  if (total === 0) {
    return { rate: null, published: 0, activeErrors: errors, label: "sem produtos publicados" };
  }
  const rate = 1 - Math.min(errors, total) / total;
  return { rate, published: total, activeErrors: errors, label: `${Math.round(rate * 100)}%` };
}
