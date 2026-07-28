import { authenticateAdmin } from "../utils/authenticate.server";
import { getDashboardStats } from "../../lib/importer/dashboard/getDashboardStats.server.js";

/** GET /api/dashboard/stats — contagens reais (Prisma + fila de curadoria). */
export async function loader({ request }) {
  const { session } = await authenticateAdmin(request);
  const stats = await getDashboardStats(session.shop);
  return Response.json({ ok: true, stats });
}
