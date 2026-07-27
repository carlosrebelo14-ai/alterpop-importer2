import { authenticateAdmin } from "../utils/authenticate.server";
import { getSitemapFilterCounts } from "../../lib/importer/catalog/catalogProductsDb.server.js";
import { isCatalogRebuildRunning } from "../../lib/importer/catalog/catalogRebuild.server.js";

/** GET /api/products/filter-counts?brand= */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  if (isCatalogRebuildRunning(session.shop)) {
    return Response.json({ ok: true, counts: {} });
  }

  const url = new URL(request.url);
  const brand = url.searchParams.get("brand") || null;
  const counts = await getSitemapFilterCounts(session.shop, brand);

  return Response.json({ ok: true, counts });
};
