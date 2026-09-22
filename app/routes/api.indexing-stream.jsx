import { authenticateAdmin } from "../utils/authenticate.server";
import {
  subscribeIndexingEvents,
  isCatalogIndexingRunning,
  readCatalogRebuildStatus,
} from "../../lib/importer/catalog/indexingStream.server.js";

/**
 * GET /api/indexing-stream — Server-Sent Events do progresso de indexação.
 *
 * Fix de segurança (auditoria 2026-09-22) — esta rota costumava saltar
 * authenticateAdmin sempre que o pedido trazia `?shop=`, usando esse valor tal e
 * qual (não verificado) para decidir de que loja transmitir o estado de indexação.
 * Isso permitia a qualquer pedido não autenticado (sem cookie, sem sessão) ler o
 * progresso de indexação de OUTRA loja só por adivinhar o domínio .myshopify.com.
 * A troca tinha sido feita (commit 4af563d) para contornar o EventSource nativo não
 * conseguir seguir um redirect 302 de reautenticação — mas authenticateAdmin já
 * suporta o caso: aceita o session token pelo parâmetro de URL `id_token`, não só
 * pelo cabeçalho Authorization (que o EventSource não consegue definir). O
 * frontend passa a pedir esse token à App Bridge (`shopify.idToken()`) e anexá-lo
 * ao URL — autenticado, sem custom headers e sem o problema do redirect.
 */
export async function loader({ request }) {
  const { session } = await authenticateAdmin(request);
  const shop = session.shop;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      /**
       * Encerra a stream uma única vez. Chamado tanto pelo abort do pedido
       * como por uma falha de enqueue (controller já fechado por uma corrida
       * entre desconexão do cliente e um evento/timer ainda em voo) — nunca
       * deixa uma exceção não apanhada matar o processo Node.
       */
      const handleClose = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* já fechado — ignorar */
        }
      };

      const send = (payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          handleClose();
        }
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

      request.signal?.addEventListener?.("abort", handleClose);
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
