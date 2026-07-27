import { authenticateAdmin } from "../utils/authenticate.server";
import { getTaxonomySectionsForUi } from "../../lib/importer/catalog/taxonomy.server.js";

/** GET /api/taxonomy — hierarquia EN para filtros (sem CSV em RAM). */
export const loader = async ({ request }) => {
  await authenticateAdmin(request);
  const sections = getTaxonomySectionsForUi();
  console.log("[debug:curation] GET /api/taxonomy", {
    sections: sections.length,
    children: sections.reduce((n, s) => n + s.children.length, 0),
  });

  return Response.json({
    ok: true,
    sections,
  });
};
