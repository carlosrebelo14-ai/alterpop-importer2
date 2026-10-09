/**
 * Limite do export CSV da Curadoria. Antes, um filtro com mais de 5 000 produtos exportava os
 * primeiros 5 000 SEM AVISAR (09/10/2026, varrimento de limites silenciosos). Agora recusa, com
 * uma mensagem que diz o total do filtro e o limite — impossível de ignorar.
 */
export const EXPORT_LIMIT = 5000;

/**
 * @param {number} total produtos do filtro
 * @param {number} [limit]
 * @returns {string|null} a mensagem de recusa, ou null se cabe
 */
export function exportLimitMessage(total, limit = EXPORT_LIMIT) {
  if (!Number.isFinite(total) || total <= limit) return null;
  // Milhares com espaço também nos 4 dígitos ("5 000"); toLocaleString("pt-PT") não os agrupa.
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `O filtro tem ${fmt(total)} produtos e a exportação aceita até ${fmt(limit)}. Restringe o filtro.`;
}
