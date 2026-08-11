import { authenticateAdmin } from "../utils/authenticate.server";
import { getCurationLiteStats } from "../../lib/importer/dashboard/getDashboardStats.server.js";

/**
 * GET /api/dashboard/stats — usado pela Curadoria só depois de uma ação (aprovar/
 * rejeitar/undo/publicar), para atualizar os totais mostrados. Versão leve: os 5
 * campos que a Curadoria usa (totalIndexed, totalApproved, totalRejected,
 * totalPending, totalSyncError) — sem os KPIs de receita/margem/inventário, que só
 * existem em /app/reports. Para o polling recorrente de 5-15s, ver
 * /api/dashboard/poll-stats (ainda mais leve, sem ler a fila de curadoria).
 */
export async function loader({ request }) {
  const { session } = await authenticateAdmin(request);
  const stats = await getCurationLiteStats(session.shop);
  return Response.json({ ok: true, stats });
}
