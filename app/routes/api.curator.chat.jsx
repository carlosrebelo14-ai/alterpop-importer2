import { authenticateAdmin } from "../utils/authenticate.server";
import { runCuratorChat } from "../../server/lib/curatorChat.js";

/**
 * POST /api/curator/chat
 * Body: { message: string, history?: { role, text }[] }
 */
export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  try {
    const result = await runCuratorChat({
      shop: session.shop,
      message: body.message,
      history: body.history || [],
    });

    if (!result.ok) {
      const status = /quota|API|GOOGLE|Gemini/i.test(result.error || "")
        ? 503
        : 400;
      return Response.json(result, { status });
    }

    return Response.json(result);
  } catch (err) {
    console.error("[api/curator/chat]", err?.message || err);
    return Response.json(
      { ok: false, error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
};
