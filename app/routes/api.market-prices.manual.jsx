import { authenticateAdmin } from "../utils/authenticate.server";
import { recordMarketObservation } from "../../lib/importer/pricing/marketPrice.server.js";
import { MarketPriceError } from "../../lib/importer/pricing/marketPrice.js";

/**
 * POST /api/market-prices/manual — grava uma observação MANUAL de preço de mercado
 * (Decisão 31). Corpo JSON { sku, price (€, com IVA como se vê na loja), store (ex.: Worten,
 * Fnac), observedAt? (ISO; omissão = agora) }. Cada pedido é um registo novo; o painel mostra
 * o mais recente. Sem recolha automática, sem validade, sem bloqueios — e sem diferença
 * calculada para o preço Alterpop (o observado tem IVA, o nosso não).
 * Resposta: { ok: true, observation } · 400 dados inválidos · 404 SKU fora do catálogo.
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
    const createdBy = session.email || (session.userId != null ? `user:${session.userId}` : session.shop);
    const observation = await recordMarketObservation(session.shop, body, { createdBy });
    return Response.json({ ok: true, observation });
  } catch (err) {
    if (err instanceof MarketPriceError) {
      return Response.json({ ok: false, error: err.message }, { status: /** @type {any} */ (err).code === "NOT_FOUND" ? 404 : 400 });
    }
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};
