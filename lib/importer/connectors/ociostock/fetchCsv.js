import { mapOcioStockRow } from "./csvFieldMap.js";
import { streamOcioStockRows } from "./streamCsv.js";

/**
 * @deprecated Usar streamOcioStockRows — esta função acumula linhas em RAM.
 * Mantida só para scripts legados com limite explícito.
 * @param {{ maxRows?: number }} [opts]
 * @returns {Promise<import('../../types.js').ProductRecord[]>}
 */
export async function fetchAndParseOcioStockCsv(opts = {}) {
  const maxRows = opts.maxRows ?? 0;
  console.warn(
    "[ociostock] fetchAndParseOcioStockCsv() carrega o CSV em RAM — preferir streamOcioStockRows()"
  );

  const records = [];
  await streamOcioStockRows({
    shouldStop: () => maxRows > 0 && records.length >= maxRows,
    onRow: async (rawRow) => {
      const record = mapOcioStockRow(rawRow);
      if (record) records.push(record);
    },
  });

  return records;
}
