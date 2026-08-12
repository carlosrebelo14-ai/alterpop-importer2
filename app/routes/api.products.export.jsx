import { authenticateAdmin } from "../utils/authenticate.server";
import { expandFilterIdsForQuery } from "../../lib/importer/catalog/taxonomy.server.js";
import { queryCatalogProducts } from "../../lib/importer/catalog/catalogProductsDb.server.js";
import { buildCsv } from "../../lib/importer/catalog/csvExport.server.js";
import { loadCurationQueue } from "../../lib/curation/curationQueue.server.js";
import { computeCurationSkuFilter } from "../../lib/curation/curationStatusFilter.server.js";
import { computeShopifyRetailPrice } from "../../lib/importer/shopify/shopifyMapper.server.js";

// Limite de segurança — o mesmo já usado em getMatchingCatalogSkus() para "todos os
// resultados do filtro" (catalogProductsDb.server.js). Ficheiros maiores do que isto
// tornam-se difíceis de editar à mão em Excel/Sheets de qualquer forma.
const EXPORT_LIMIT = 5000;

const HEADERS = ["sku", "ean", "custo", "titulo", "categoria", "preco", "estado"];

/**
 * GET /api/products/export?<mesmos parâmetros de /api/products>
 * CSV com os produtos que correspondem ao filtro activo. Colunas sku/ean/custo
 * são só para referência (o re-import ignora edições nelas); titulo/categoria/
 * preco/estado são editáveis e voltam pelo /api/products/import-edits.
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const url = new URL(request.url);

  const brand = url.searchParams.get("brand") || null;
  const filtersRaw = url.searchParams.get("filters") || "";
  const search = url.searchParams.get("search") || "";
  const searchScope = url.searchParams.get("searchScope") || "all";
  const minPrice = url.searchParams.get("minPrice") || null;
  const maxPrice = url.searchParams.get("maxPrice") || null;
  const inStockOnlyParam = url.searchParams.get("inStockOnly");
  const inStockOnly = inStockOnlyParam === "1" || inStockOnlyParam === "true" || inStockOnlyParam === "on";
  const curationStatus = url.searchParams.get("curationStatus") || null;
  const reasonFilter = url.searchParams.get("reason") || null;

  const filterIds = expandFilterIdsForQuery(
    filtersRaw.split(",").map((s) => s.trim()).filter(Boolean)
  );

  const { skuInclude, skuExclude } = await computeCurationSkuFilter(curationStatus, reasonFilter);

  const result = await queryCatalogProducts(session.shop, {
    page: 1,
    limit: EXPORT_LIMIT,
    brand,
    filterIds,
    search,
    searchScope,
    minPrice,
    maxPrice,
    inStockOnly,
    skuInclude,
    skuExclude,
  });

  const queue = await loadCurationQueue();
  const bySku = new Map((queue.items || []).map((i) => [i.sku, i]));

  const rows = result.products.map((p) => {
    const item = bySku.get(p.sku);
    const overrides = item?.metadata?.overrides || {};
    const titulo = overrides.title || p.title || "";
    const categoria = overrides.category || p.categoryMain || "";
    const precoBase = computeShopifyRetailPrice(p.netPrice);
    const preco = overrides.price != null ? overrides.price : precoBase;
    const estado = item?.status || "NO_DECISION";
    return [
      p.sku,
      p.barcode || "",
      p.netPrice != null ? p.netPrice.toFixed(2) : "",
      titulo,
      categoria,
      preco != null ? Number(preco).toFixed(2) : "",
      estado,
    ];
  });

  const csv = buildCsv(HEADERS, rows);
  const filename = `alterpop-curadoria-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
