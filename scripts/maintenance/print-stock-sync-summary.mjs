#!/usr/bin/env node
/**
 * D2 (PR D). Corre na Fly, a partir de /app: lê o stock-sync-summary.json e imprime UMA linha com números.
 * Nunca imprime texto do ficheiro. Ficheiro adulterado ou ilegível dá estado=invalido e mais nada.
 *   SSS: estado=ok ranAt=<ISO> checked=N found=N notFound=N error=N causas=<causa:N,...|-> desativados=N
 *   SSS: estado=ausente | SSS: estado=invalido
 * Uso: node scripts/maintenance/print-stock-sync-summary.mjs
 */
import { resolveCurationDataDir } from "../../lib/curation/dataDir.js";
import { readStockSyncSummary } from "../../lib/importer/shopify/stockSyncSummary.js";

const r = readStockSyncSummary(resolveCurationDataDir());
if (r.status !== "ok") {
  console.log(`SSS: estado=${r.status}`);
} else {
  const s = r.summary;
  const causas = Object.entries(s.errorByCause)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
  console.log(`SSS: estado=ok ranAt=${s.ranAt} checked=${s.checked} found=${s.found} notFound=${s.notFound} error=${s.error} causas=${causas || "-"} desativados=${s.desativados}`);
}
