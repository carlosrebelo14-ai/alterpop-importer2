/**
 * @param {import('../types.js').ProductRecord[]} records
 * @param {import('../types.js').ImportFilters} filters
 * @param {import('../jobs/ImportJob.js').ImportJob} job
 */
export function applyRecordFilters(records, filters = {}, job = null) {
  if (!filters || Object.keys(filters).length === 0) return records;

  return records.filter((record) => {
    if (filters.inStockOnly && record.availableQuantity <= 0 && !record.hasStock) {
      job?.recordSkipped({ sku: record.sku, reason: "out of stock filter" });
      return false;
    }

    if (filters.availability?.length) {
      const avail = String(record.availability);
      if (!filters.availability.includes(avail)) {
        job?.recordSkipped({ sku: record.sku, reason: "availability filter" });
        return false;
      }
    }

    if (filters.categoryMain?.length) {
      if (!filters.categoryMain.includes(record.categoryMain)) {
        job?.recordSkipped({ sku: record.sku, reason: "category filter" });
        return false;
      }
    }

    if (filters.categorySegments?.length) {
      const match = record.categorySegments?.some((s) => filters.categorySegments.includes(s));
      if (!match) {
        job?.recordSkipped({ sku: record.sku, reason: "subcategory filter" });
        return false;
      }
    }

    if (filters.brands?.length) {
      if (!filters.brands.includes(record.vendor)) {
        job?.recordSkipped({ sku: record.sku, reason: "brand filter" });
        return false;
      }
    }

    if (filters.franchises?.length) {
      const match = record.franchises?.some((f) => filters.franchises.includes(f));
      if (!match) {
        job?.recordSkipped({ sku: record.sku, reason: "franchise filter" });
        return false;
      }
    }

    return true;
  });
}

/**
 * @param {import('../types.js').ProductRecord[]} records
 */
export function countMatchingRecords(records, filters = {}) {
  return applyRecordFilters(records, filters).length;
}

/**
 * Conta correspondências sem carregar o CSV inteiro em RAM.
 * @param {import('../types.js').ImportFilters} filters
 */
export async function countMatchingRecordsFromStream(filters = {}) {
  const { streamOcioStockRows } = await import("../connectors/ociostock/streamCsv.js");
  const { mapOcioStockRow } = await import("../connectors/ociostock/csvFieldMap.js");
  const { passesRecordFilters } = await import("./passesRecordFilters.js");

  let matchCount = 0;
  await streamOcioStockRows({
    onRow: async (rawRow) => {
      const record = mapOcioStockRow(rawRow);
      if (record && passesRecordFilters(record, filters)) {
        matchCount += 1;
      }
    },
  });
  return matchCount;
}
