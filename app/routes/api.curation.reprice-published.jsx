import { authenticateAdmin } from "../utils/authenticate.server";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { resolveFilteredSkus } from "../../lib/curation/resolveFilteredSkus.server.js";
import {
  buildRepricePreview,
  executeReprice,
  RepriceError,
  CONFIRM_THRESHOLD,
} from "../../lib/importer/shopify/publishedReprice.server.js";
import { invalidateCurationQueueCache } from "../../lib/importer/curation/index.js";
import { clearLivePriceCache } from "../../lib/importer/shopify/livePricePanel.server.js";

/**
 * "Aplicar aos publicados" — mudar a margem nunca mexe na loja; esta ação separada atualiza
 * os preços dos produtos já publicados.
 *
 * GET  → { published, outdated }: quantos publicados têm a regra desatualizada (ativa o botão).
 * POST { action: 'preview', mode: 'rule'|'filter', filters? }
 *      → pré-visualização, lida da Shopify no momento. Não escreve nada.
 * POST { action: 'execute', mode, filters?, confirmCount }
 *      → escreve. confirmCount = nº de produtos do âmbito mostrado; se diferir, recusa.
 *        Recusa com um ciclo de sync a correr.
 */
async function makeClient(shop) {
  return createShopifyClientFromSession(await loadOfflineSessionForShop(shop));
}

export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  try {
    const p = await buildRepricePreview({ shop: session.shop, client: await makeClient(session.shop), mode: "rule" });
    return Response.json({ ok: true, published: p.publishedTotal, outdated: p.outdatedTotal });
  } catch (err) {
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};

export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  if (request.method !== "POST") return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });

  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  const mode = body.mode === "filter" ? "filter" : body.mode === "rule" ? "rule" : null;
  if (!mode) return Response.json({ ok: false, error: "Âmbito inválido." }, { status: 400 });

  try {
    const shop = session.shop;
    const skus = mode === "filter" ? await resolveFilteredSkus(shop, body.filters || {}) : [];
    const client = await makeClient(shop);

    if (body.action === "preview") {
      const preview = await buildRepricePreview({ shop, client, mode, skus });
      return Response.json({ ok: true, confirmThreshold: CONFIRM_THRESHOLD, ...preview });
    }
    if (body.action === "execute") {
      const result = await executeReprice({
        shop,
        client,
        mode,
        skus,
        confirmCount: Number.isInteger(body.confirmCount) ? body.confirmCount : null,
      });
      invalidateCurationQueueCache();
      clearLivePriceCache();
      return Response.json({ ok: true, ...result });
    }
    return Response.json({ ok: false, error: "Ação inválida." }, { status: 400 });
  } catch (err) {
    if (err instanceof RepriceError) {
      const status = err.code === "SYNC_RUNNING" || err.code === "SCOPE_CHANGED" ? 409 : 400;
      return Response.json({ ok: false, code: err.code, error: err.message, confirmed: err.confirmed, now: err.now }, { status });
    }
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};
