/**
 * GET /api/health — endpoint público (sem OAuth/sessão Shopify).
 * Usar com monitorização externa (UptimeRobot, Better Stack, etc.).
 */

const HEALTH_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Content-Type": "application/json; charset=utf-8",
  "X-Alterpop-Health": "1",
};

export const loader = async ({ request }) => {
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: HEALTH_HEADERS });
  }

  return Response.json(
    { status: "alive", timestamp: Date.now() },
    { status: 200, headers: HEALTH_HEADERS }
  );
};
