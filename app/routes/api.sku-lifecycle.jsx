import { authenticateAdmin } from "../utils/authenticate.server";
import {
  getLatestLifecycleReport,
  listSkusForReview,
} from "../../lib/importer/catalog/skuLifecycle.server.js";

/**
 * GET /api/sku-lifecycle — item 2/3 do pacote de melhorias criativas de 2026-08-12.
 * Banner de novidades na Curadoria (último ciclo) + lista de "para revisão" em Relatórios.
 */
export async function loader({ request }) {
  const { session } = await authenticateAdmin(request);
  const url = new URL(request.url);
  const includeReviewList = url.searchParams.get("review") === "1";

  const [latest, forReview] = await Promise.all([
    getLatestLifecycleReport(session.shop),
    includeReviewList ? listSkusForReview(session.shop) : Promise.resolve(null),
  ]);

  return Response.json({ ok: true, latest, forReview });
}
