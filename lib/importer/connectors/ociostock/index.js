import { fetchAndParseOcioStockCsv } from "./fetchCsv.js";

export const SOURCE = "ociostock";

/** @deprecated Prefer streamOcioStockRows */
export async function fetchRows(opts) {
  return fetchAndParseOcioStockCsv(opts);
}

export { mapOcioStockRow } from "./csvFieldMap.js";
export { streamOcioStockRows } from "./streamCsv.js";
