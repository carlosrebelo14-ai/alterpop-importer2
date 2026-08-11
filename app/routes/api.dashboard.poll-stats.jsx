import { authenticateAdmin } from "../utils/authenticate.server";
import { getPollStats } from "../../lib/importer/dashboard/getDashboardStats.server.js";

/**
 * GET /api/dashboard/poll-stats — usado pelo polling recorrente da Curadoria
 * (a cada 5-15s enquanto a página está aberta). NÃO lê curation-queue.json —
 * só totalIndexed (COUNT) e totalSyncError (SyncErrorLog). Medido: ~10-15ms,
 * contra ~800ms de getDashboardStats() que corria neste ciclo antes.
 */
export async function loader({ request }) {
  const { session } = await authenticateAdmin(request);
  const stats = await getPollStats(session.shop);
  return Response.json({ ok: true, stats });
}
