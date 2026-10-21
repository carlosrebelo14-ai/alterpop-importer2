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
import { reservarPublicacaoEntreProcessos } from "../../lib/importer/shopify/publicacaoEmCurso.js";
import { marcarAtividadeApp } from "../../lib/curation/atividadeApp.js";

/**
 * "Aplicar aos publicados" — mudar a margem nunca mexe na loja; esta ação separada atualiza
 * os preços dos produtos já publicados.
 *
 * GET  → { published, outdated, rule }: quantos publicados têm a regra desatualizada (ativa
 *        o botão) e a regra de preço do servidor (PRICE_MODE).
 * POST { action: 'preview', mode: 'rule'|'filter', filters?, rule?: 'NET'|'LEGACY', includeManual? }
 *      → pré-visualização, lida da Shopify no momento. Não escreve nada. `rule` calcula numa
 *        regra pedida sem mudar a global (pré-visualizar NET com PRICE_MODE desligada).
 * POST { action: 'execute', mode, filters?, confirmCount, rule?, includeManual? }
 *      → escreve. confirmCount = nº de produtos do âmbito mostrado; se diferir, recusa.
 *        Recusa com um ciclo de sync a correr e com `rule` diferente da do servidor (409).
 */
async function makeClient(shop) {
  return createShopifyClientFromSession(await loadOfflineSessionForShop(shop));
}

export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  try {
    const p = await buildRepricePreview({ shop: session.shop, client: await makeClient(session.shop), mode: "rule" });
    return Response.json({ ok: true, published: p.publishedTotal, outdated: p.outdatedTotal, rule: p.serverRule });
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

    const rule = body.rule == null || body.rule === "" ? null : String(body.rule);
    const includeManual = body.includeManual === true;

    if (body.action === "preview") {
      const preview = await buildRepricePreview({ shop, client, mode, skus, rule, includeManual });
      return Response.json({ ok: true, confirmThreshold: CONFIRM_THRESHOLD, ...preview });
    }
    if (body.action === "execute") {
      // DBG-47 (Decisão 28): a escrita em massa de preços usa a mesma reserva da publicação. Ocupada, recusa com 409.
      const reserva = await reservarPublicacaoEntreProcessos({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) });
      if (!reserva) {
        return Response.json(
          { ok: false, code: "PUBLICACAO_EM_CURSO", error: "Há uma publicação ou um reset Shopify em curso. Espera que termine antes de atualizar preços." },
          { status: 409 }
        );
      }
      let result;
      try {
        result = await executeReprice({
          shop,
          client,
          mode,
          skus,
          rule,
          includeManual,
          confirmCount: Number.isInteger(body.confirmCount) ? body.confirmCount : null,
        });
      } finally {
        await reserva.libertar();
      }
      invalidateCurationQueueCache();
      clearLivePriceCache();
      return Response.json({ ok: true, ...result });
    }
    return Response.json({ ok: false, error: "Ação inválida." }, { status: 400 });
  } catch (err) {
    if (err instanceof RepriceError) {
      const status = err.code === "SYNC_RUNNING" || err.code === "SCOPE_CHANGED" || err.code === "RULE_MISMATCH" ? 409 : 400;
      return Response.json({ ok: false, code: err.code, error: err.message, confirmed: err.confirmed, now: err.now }, { status });
    }
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};
