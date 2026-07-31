import { authenticateAdmin } from "../utils/authenticate.server";
import { expandFilterIdsForQuery } from "../../lib/importer/catalog/taxonomy.server.js";
import { queryCatalogProducts } from "../../lib/importer/catalog/catalogProductsDb.server.js";
import { isCatalogIndexingRunning } from "../../lib/importer/catalog/indexingStream.server.js";
import { attachDebugMockIfEmpty } from "../../lib/importer/catalog/curationMock.server.js";

/**
 * GET /api/products?page=1&limit=50&brand=&filters=&search=&counts=1
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  const indexing = isCatalogIndexingRunning(session.shop);

  const url = new URL(request.url);
  const page = url.searchParams.get("page") || "1";
  const limit = url.searchParams.get("limit") || "50";
  const brand = url.searchParams.get("brand") || null;
  const filtersRaw = url.searchParams.get("filters") || "";
  const search = url.searchParams.get("search") || "";
  const minPrice = url.searchParams.get("minPrice") || null;
  const maxPrice = url.searchParams.get("maxPrice") || null;
  const inStockOnlyParam = url.searchParams.get("inStockOnly");
  const inStockOnly = inStockOnlyParam === "1" || inStockOnlyParam === "true" || inStockOnlyParam === "on";
  const includeCounts = url.searchParams.get("counts") === "1";
  const sortBy = url.searchParams.get("sortBy") || null;
  const sortDir = url.searchParams.get("sortDir") || null;
  const curationStatus = url.searchParams.get("curationStatus") || null;

  const filterIds = expandFilterIdsForQuery(
    filtersRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  console.log("[debug:curation] GET /api/products params", {
    shop: session.shop,
    page,
    limit,
    brand: brand || null,
    filtersRaw,
    filterIdsExpanded: filterIds,
    search: search || null,
    sortBy,
    sortDir,
    curationStatus,
  });

  let skuInclude = undefined;
  let skuExclude = undefined;

  if (curationStatus) {
    const { loadCurationQueue } = await import("../../lib/curation/curationQueue.server.js");
    const queue = await loadCurationQueue();
    const items = queue.items || [];
    
    if (curationStatus === "NO_DECISION") {
      skuExclude = items.map((item) => item.sku);
    } else {
      skuInclude = items
        .filter((item) => item.status === curationStatus)
        .map((item) => item.sku);
    }
  }

  let result = await queryCatalogProducts(session.shop, {
    page,
    limit,
    brand,
    filterIds,
    search,
    minPrice,
    maxPrice,
    inStockOnly,
    includeCounts,
    sortBy,
    sortDir,
    skuInclude,
    skuExclude,
  });

  result = attachDebugMockIfEmpty(result, filterIds);

  console.log("[debug:curation] GET /api/products result", {
    totalCount: result.totalCount,
    returned: result.products?.length ?? 0,
    debugMock: result._debugMock === true,
  });

  return Response.json({ ok: true, rebuilding: indexing, indexingActive: indexing, ...result });
};
