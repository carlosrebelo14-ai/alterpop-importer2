import { authenticateAdmin } from "../utils/authenticate.server";
import {
  subscribeIndexingEvents,
  isCatalogIndexingRunning,
  readCatalogRebuildStatus,
} from "../../lib/importer/catalog/indexingStream.server.js";

/**
 * GET /api/indexing-stream — Server-Sent Events do progresso de indexação.
 */
export async function loader({ request }) {
  const { session } = await authenticateAdmin(request);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      send({ type: "connected", shop: session.shop });

      readCatalogRebuildStatus(session.shop).then((status) => {
        const isRunning = isCatalogIndexingRunning(session.shop) || status.state === "running" || status.indexing === true;
        send({
          type: "status",
          rebuilding: isRunning,
          indexed: status.totalImported ?? status.checkpointIndexed ?? status.totalRows ?? 0,
          scanned: status.totalLinesRead ?? status.checkpointScanned ?? status.scanned ?? 0,
          phase: status.phase || (status.state === "completed" ? "done" : isRunning ? "streaming" : "idle"),
          ...status,
          audit: status.audit || null,
        });
      });

      const unsubscribe = subscribeIndexingEvents(session.shop, (event) => {
        send(event);
      });

      const heartbeat = setInterval(() => {
        send({ type: "ping", at: Date.now() });
      }, 25000);

      request.signal?.addEventListener?.("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
