/** Produto de diagnóstico quando a query com filtros devolve vazio. */
export const CURATION_DEBUG_MOCK_PRODUCT = {
  sku: "__DEBUG_MOCK_SKU__",
  title: "[DEBUG] Mock — catálogo sem tags para este filtro. Actualizar catálogo.",
  categoryMain: "Action Figures",
  categorySegments: ["Anime & Manga"],
  vendor: "DEBUG",
  stock: 1,
  franchises: [],
};

export function attachDebugMockIfEmpty(result, filterIds) {
  if (!filterIds?.length) return result;
  if (result.totalCount > 0 && result.products?.length > 0) return result;

  console.log("[debug:curation] Query vazia com filtros — inject mock", { filterIds });

  return {
    ...result,
    products: [CURATION_DEBUG_MOCK_PRODUCT],
    totalCount: 1,
    totalPages: 1,
    _debugMock: true,
  };
}
