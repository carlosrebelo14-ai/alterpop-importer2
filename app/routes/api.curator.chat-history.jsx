import { authenticateAdmin } from "../utils/authenticate.server";
import { listCuratorChatHistory } from "../../lib/curation/curatorChatLog.server.js";

/**
 * GET /api/curator/chat-history?limit=50
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const url = new URL(request.url);
  const limit = Math.min(200, parseInt(url.searchParams.get("limit") || "50", 10) || 50);
  const history = await listCuratorChatHistory(session.shop, limit);
  return Response.json({ ok: true, history });
};
