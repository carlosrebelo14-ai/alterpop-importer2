/**
 * @param {import('../types.js').ProductRecord} record
 * @param {import('../types.js').ImportFilters} filters
 * @param {import('../jobs/ImportJob.js').ImportJob} [job]
 * @returns {boolean}
 */
export function passesRecordFilters(record, filters = {}, job = null) {
  if (!filters || Object.keys(filters).length === 0) return true;

  // Camada agnóstica: o motor usa campos genéricos normalizados.
  const normalized = {
    brand: record.brand ?? record.vendor ?? "",
    category: record.category ?? record.categoryMain ?? "",
    categorySegments: record.categorySegments || [],
    price: record.price ?? record.netPrice ?? null,
    stock: record.stock ?? record.availableQuantity ?? 0,
    barcode: record.barcode ?? null,
    availability: record.availability,
    tags: record.tags ?? record.franchises ?? [],
  };

  if (filters.inStockOnly && Number(normalized.stock) <= 0 && !record.hasStock) {
    job?.recordSkipped({ sku: record.sku, reason: "out of stock filter" });
    return false;
  }

  if (filters.availability?.length) {
    const avail = String(normalized.availability);
    if (!filters.availability.includes(avail)) {
      job?.recordSkipped({ sku: record.sku, reason: "availability filter" });
      return false;
    }
  }

  if (filters.categoryMain?.length) {
    if (!filters.categoryMain.includes(normalized.category)) {
      job?.recordSkipped({ sku: record.sku, reason: "category filter" });
      return false;
    }
  }

  if (filters.categorySegments?.length) {
    const match = normalized.categorySegments?.some((s) => filters.categorySegments.includes(s));
    if (!match) {
      job?.recordSkipped({ sku: record.sku, reason: "subcategory filter" });
      return false;
    }
  }

  if (filters.brands?.length) {
    if (!filters.brands.includes(normalized.brand)) {
      job?.recordSkipped({ sku: record.sku, reason: "brand filter" });
      return false;
    }
  }

  if (filters.franchises?.length) {
    const match = normalized.tags?.some((f) => filters.franchises.includes(f));
    if (!match) {
      job?.recordSkipped({ sku: record.sku, reason: "franchise filter" });
      return false;
    }
  }

  return true;
}
