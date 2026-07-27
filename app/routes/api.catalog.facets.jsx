import { authenticateAdmin } from "../utils/authenticate.server";
import { getCatalogFacetsForUi } from "../../lib/importer/catalog/catalogFacets.server.js";
import { isCatalogRebuildRunning } from "../../lib/importer/catalog/catalogRebuild.server.js";

/** GET /api/catalog/facets — licenças, marcas e tipos de produto (EN). */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  if (isCatalogRebuildRunning(session.shop)) {
    return Response.json({
      ok: true,
      licences: [],
      brands: [],
      productTypes: [],
      indexing: true,
    });
  }

  const facets = await getCatalogFacetsForUi(session.shop);

  return Response.json({
    ok: true,
    indexing: false,
    ...facets,
  });
};
