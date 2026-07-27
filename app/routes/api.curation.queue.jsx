/**
 * GET /api/curation/queue
 * Lista produtos na fila de curadoria (por defeito: PENDING).
 */
export const loader = async ({ request }) => {
  const { authenticateAdmin } = await import("../utils/authenticate.server");
  const { loadCurationQueue } = await import("../../lib/curation/curationQueue.server.js");
  await authenticateAdmin(request);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "PENDING";

  const queue = await loadCurationQueue();
  const items =
    status === "ALL"
      ? queue.items
      : queue.items.filter((item) => item.status === status);

  return Response.json({
    ok: true,
    path: "server/data/curation-queue.json",
    updatedAt: queue.updatedAt,
    count: items.length,
    status,
    items,
  });
};
