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
  const url = new URL(request.url);
  let shop = url.searchParams.get("shop");

  if (!shop) {
    try {
      const { session } = await authenticateAdmin(request);
      shop = session?.shop;
    } catch {
      shop = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
    }
  }
  if (!shop) shop = "jyr17t-wr.myshopify.com";

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      send({ type: "connected", shop });

      readCatalogRebuildStatus(shop).then((status) => {
        const isRunning = isCatalogIndexingRunning(shop) || status.state === "running" || status.indexing === true;
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

      const unsubscribe = subscribeIndexingEvents(shop, (event) => {
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
