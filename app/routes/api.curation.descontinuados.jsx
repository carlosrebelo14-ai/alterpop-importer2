import { authenticateAdmin } from "../utils/authenticate.server";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { listarDescontinuados, validarSubstituto } from "../../lib/curation/descontinuados.server.js";
import {
  adicionarSubstitutoPendente,
  comPrazoDeRota,
  marcarDescontinuadoIgnorado,
} from "../../lib/curation/curationQueue.server.js";
import { invalidateCurationQueueCache } from "../../lib/importer/curation/index.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Erros de infraestrutura do painel: modo degradado e fila ocupada, com a mesma resposta das outras rotas. */
function respostaDeErro(err) {
  if (err?.code === "DB_DEGRADED") {
    return Response.json({ ok: false, error: err.message, dbDegraded: err.state ?? null }, { status: 503, headers: JSON_HEADERS });
  }
  if (err?.code === "CURATION_QUEUE_LOCK_TIMEOUT") {
    return Response.json({ ok: false, error: "fila ocupada, tenta de novo" }, { status: 503, headers: JSON_HEADERS });
  }
  return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500, headers: JSON_HEADERS });
}

async function clienteDaLoja(shop) {
  return createShopifyClientFromSession(await loadOfflineSessionForShop(shop));
}

/**
 * GET /api/curation/descontinuados — publicados que saíram do feed, com substitutos. Só leitura.
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  try {
    const lista = await listarDescontinuados({ shop: session.shop, client: await clienteDaLoja(session.shop) });
    return Response.json(lista, { headers: JSON_HEADERS });
  } catch (err) {
    return respostaDeErro(err);
  }
};

/**
 * POST /api/curation/descontinuados — { action: "usar", sku, substitutoSku } ou { action: "ignorar", sku }.
 * "Usar este" põe o substituto na fila como PENDING, marcado para aprovação. Não publica nada.
 */
export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405, headers: JSON_HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido" }, { status: 400, headers: JSON_HEADERS });
  }
  const sku = typeof body?.sku === "string" ? body.sku.trim() : "";
  if (!sku) return Response.json({ ok: false, error: "SKU em falta" }, { status: 400, headers: JSON_HEADERS });

  try {
    if (body.action === "ignorar") {
      const item = await comPrazoDeRota(() => marcarDescontinuadoIgnorado(sku));
      invalidateCurationQueueCache();
      if (!item) return Response.json({ ok: false, error: "o SKU já não está publicado na fila" }, { status: 409, headers: JSON_HEADERS });
      return Response.json({ ok: true }, { headers: JSON_HEADERS });
    }

    if (body.action === "usar") {
      const substitutoSku = typeof body?.substitutoSku === "string" ? body.substitutoSku.trim() : "";
      if (!substitutoSku) return Response.json({ ok: false, error: "substituto em falta" }, { status: 400, headers: JSON_HEADERS });
      // A regra é revalidada aqui: o painel pode mostrar uma lista antiga.
      const validacao = await validarSubstituto({ shop: session.shop, client: await clienteDaLoja(session.shop), sku, substitutoSku });
      if (!validacao.ok) return Response.json({ ok: false, error: validacao.motivo }, { status: 409, headers: JSON_HEADERS });
      const resultado = await comPrazoDeRota(() => adicionarSubstitutoPendente(validacao.registo, sku));
      invalidateCurationQueueCache();
      if (!resultado.ok) return Response.json({ ok: false, error: resultado.motivo }, { status: 409, headers: JSON_HEADERS });
      return Response.json({ ok: true, sku: substitutoSku, status: "PENDING" }, { headers: JSON_HEADERS });
    }

    return Response.json({ ok: false, error: "Ação inválida." }, { status: 400, headers: JSON_HEADERS });
  } catch (err) {
    return respostaDeErro(err);
  }
};
