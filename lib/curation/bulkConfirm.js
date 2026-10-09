/**
 * Confirmação das ações em massa (D1, briefing de integridade, 09/10/2026): aprovar, rejeitar
 * e publicar acima de BULK_CONFIRM_THRESHOLD produtos exigem que o cliente confirme o NÚMERO
 * EXATO de produtos a que a ação se vai aplicar. O servidor recusa sem confirmação e quando o
 * número confirmado não é o real — o âmbito pode ter mudado entre o ecrã de confirmação e o
 * clique (nova indexação, outro filtro, outra pessoa a aprovar).
 *
 * Partilhado: bulk (aprovar/rejeitar), publicação, e BulkActionConfirm (interface). Puro.
 */
export const BULK_CONFIRM_THRESHOLD = 50;
export const BULK_SAMPLE_SIZE = 5;

export class BulkConfirmError extends Error {
  /** @param {'CONFIRM_REQUIRED'|'COUNT_MISMATCH'} code @param {string} message @param {{ count: number, confirmed?: number|null }} extra */
  constructor(code, message, extra) {
    super(message);
    this.name = "BulkConfirmError";
    this.code = code;
    this.count = extra.count;
    this.confirmed = extra.confirmed ?? null;
  }
}

/**
 * @param {number} count nº real de produtos a que a ação se aplica
 * @param {unknown} confirmCount o que o cliente confirmou
 * @param {{ threshold?: number, what?: string }} [opts]
 */
export function assertBulkConfirm(count, confirmCount, { threshold = BULK_CONFIRM_THRESHOLD, what = "esta ação" } = {}) {
  if (count <= threshold) return;
  if (!Number.isInteger(confirmCount)) {
    throw new BulkConfirmError(
      "CONFIRM_REQUIRED",
      `${what} aplica-se a ${count} produtos (mais de ${threshold}): falta a confirmação com o número exato.`,
      { count }
    );
  }
  if (confirmCount !== count) {
    throw new BulkConfirmError(
      "COUNT_MISMATCH",
      `O âmbito mudou: confirmaste ${confirmCount} produtos e ${what} aplica-se agora a ${count}. Volta a abrir a confirmação.`,
      { count, confirmed: confirmCount }
    );
  }
}

/** true quando a confirmação está cumprida (abaixo do limiar não há nada a escrever). */
export function isBulkConfirmed(scope, typed, threshold = BULK_CONFIRM_THRESHOLD) {
  return scope <= threshold || String(typed).trim() === String(scope);
}
