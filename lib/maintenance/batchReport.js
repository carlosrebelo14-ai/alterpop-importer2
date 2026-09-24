/**
 * Reporter partilhado dos scripts de manutenção em lote — B14 (briefing backend,
 * 24/09/2026). Extraído depois do mesmo defeito aparecer duas vezes:
 * collection-description-clean.js e collection-publication-sync.js reportavam
 * processed=0 total=0 quando liam N itens mas nenhum precisava de ação. "0/0" bate
 * trivialmente contra `processed !== total` e o script saía OK, em silêncio, sem nunca
 * ter contado o lote lido.
 *
 * checkBatchCounts é pura, testável sem I/O (scripts/tests/batch-report.test.js).
 * reportBatchDone é o wrapper fino que os scripts chamam no fim — imprime a linha DONE
 * e sai com process.exit(1) se algo bater mal, incluindo erros de escrita.
 */

/**
 * @param {{ itemsRead: number, processed: number, total: number }} args
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function checkBatchCounts({ itemsRead, processed, total }) {
  if (itemsRead > 0 && (processed === 0 || total === 0)) {
    return {
      ok: false,
      reason: `${itemsRead} item(ns) lido(s) mas processed=${processed} total=${total} — o reporter não está a contar o lote lido.`,
    };
  }
  if (processed !== total) {
    return { ok: false, reason: `processed (${processed}) != total (${total})` };
  }
  return { ok: true, reason: null };
}

/**
 * Imprime "[tag] DONE. processed=X total=Y ..." e sai com process.exit(1) se
 * checkBatchCounts falhar ou se errorCount > 0. Nunca falha em silêncio.
 * @param {{ tag: string, itemsRead: number, processed: number, total: number, errorCount?: number, extra?: string }} args
 */
export function reportBatchDone({ tag, itemsRead, processed, total, errorCount = 0, extra = "" }) {
  console.log(`[${tag}] DONE. processed=${processed} total=${total}${extra ? ` ${extra}` : ""}`);

  const counts = checkBatchCounts({ itemsRead, processed, total });
  if (!counts.ok) {
    console.error(`[${tag}] FATAL: ${counts.reason}`);
    process.exit(1);
  }
  if (errorCount > 0) {
    process.exit(1);
  }
}
