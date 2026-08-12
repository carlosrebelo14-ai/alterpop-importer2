import { authenticateAdmin } from "../utils/authenticate.server";
import { expandFilterIdsForQuery } from "../../lib/importer/catalog/taxonomy.server.js";
import { queryCatalogProducts } from "../../lib/importer/catalog/catalogProductsDb.server.js";
import { isCatalogIndexingRunning } from "../../lib/importer/catalog/indexingStream.server.js";

/**
 * Motivos como "blocked_brand:FOO" ou "structured_min_price:3<4" trazem um sufixo
 * parametrizado depois de ":" — o filtro compara só a parte antes disso.
 * @param {string} reason
 */
function reasonBaseToken(reason) {
  return String(reason || "").split(":")[0];
}

/**
 * @param {{ reason?: string, metadata?: { curationReasons?: string[] } }} item
 * @param {string} reasonFilter
 */
function itemMatchesReason(item, reasonFilter) {
  if (reasonBaseToken(item?.reason) === reasonFilter) return true;
  const extra = item?.metadata?.curationReasons;
  if (Array.isArray(extra)) {
    return extra.some((r) => reasonBaseToken(r) === reasonFilter);
  }
  return false;
}

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
  const searchScope = url.searchParams.get("searchScope") || "all";
  const minPrice = url.searchParams.get("minPrice") || null;
  const maxPrice = url.searchParams.get("maxPrice") || null;
  const inStockOnlyParam = url.searchParams.get("inStockOnly");
  const inStockOnly = inStockOnlyParam === "1" || inStockOnlyParam === "true" || inStockOnlyParam === "on";
  const includeCounts = url.searchParams.get("counts") === "1";
  const sortBy = url.searchParams.get("sortBy") || null;
  const sortDir = url.searchParams.get("sortDir") || null;
  const curationStatus = url.searchParams.get("curationStatus") || null;
  const reasonFilter = url.searchParams.get("reason") || null;

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

  if (curationStatus || reasonFilter) {
    const { loadCurationQueue } = await import("../../lib/curation/curationQueue.server.js");
    const queue = await loadCurationQueue();
    const items = queue.items || [];

    if (curationStatus === "NO_DECISION" && !reasonFilter) {
      skuExclude = items.map((item) => item.sku);
    } else {
      let filtered = items;
      if (curationStatus && curationStatus !== "NO_DECISION") {
        filtered = filtered.filter((item) => item.status === curationStatus);
      } else if (curationStatus === "NO_DECISION") {
        // NO_DECISION + motivo não faz sentido (sem decisão não tem motivo registado);
        // fica vazio em vez de devolver o catálogo inteiro por engano.
        filtered = [];
      }
      if (reasonFilter) {
        filtered = filtered.filter((item) => itemMatchesReason(item, reasonFilter));
      }
      skuInclude = filtered.map((item) => item.sku);
    }
  }

  const result = await queryCatalogProducts(session.shop, {
    page,
    limit,
    brand,
    filterIds,
    search,
    searchScope,
    minPrice,
    maxPrice,
    inStockOnly,
    includeCounts,
    sortBy,
    sortDir,
    skuInclude,
    skuExclude,
  });

  console.log("[debug:curation] GET /api/products result", {
    totalCount: result.totalCount,
    returned: result.products?.length ?? 0,
  });

  return Response.json({ ok: true, rebuilding: indexing, indexingActive: indexing, ...result });
};
