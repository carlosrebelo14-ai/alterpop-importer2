import { authenticateAdmin } from "../utils/authenticate.server";
import {
  initShopifyResetJob,
  isShopifyResetRunning,
  readShopifyResetStatus,
} from "../../lib/importer/shopify/shopifyResetJob.server.js";
import {
  countShopifyProductsForReset,
  startShopifyCatalogResetInBackground,
} from "../../lib/importer/shopify/shopifyReset.server.js";
import { isShopifySyncRunning } from "../../lib/importer/shopify/shopifySyncJob.server.js";
import {
  loadOfflineSessionForShop,
  ShopifyAuthSessionError,
} from "../../lib/session/loadOfflineSessionForShop.server.js";

const CONFIRM_WORD = "APAGAR";

/**
 * GET /api/shopify-reset — progresso do reset (polling UI).
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const status = await readShopifyResetStatus(session.shop);
  const url = new URL(request.url);
  const wantPreview = url.searchParams.get("preview") === "1";

  let previewCount = null;
  if (wantPreview) {
    try {
      previewCount = await countShopifyProductsForReset(session);
    } catch (err) {
      const message =
        err instanceof ShopifyAuthSessionError
          ? err.message
          : err?.message || "Não foi possível contar produtos.";
      return Response.json({ ok: false, error: message, authError: true }, { status: 401 });
    }
  }

  return Response.json({
    ok: true,
    status,
    previewCount,
    running:
      status.state === "running" ||
      status.state === "listing" ||
      status.state === "deleting",
  });
};

/**
 * POST /api/shopify-reset — inicia apagamento em massa (requer confirm: "APAGAR").
 */
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticateAdmin(request);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  if (body.confirm !== CONFIRM_WORD) {
    return Response.json(
      {
        ok: false,
        error: `Confirmação inválida. Escreve exactamente "${CONFIRM_WORD}" para continuar.`,
      },
      { status: 400 }
    );
  }

  if (await isShopifyResetRunning(session.shop)) {
    const status = await readShopifyResetStatus(session.shop);
    return Response.json(
      { ok: false, error: "Já existe um reset Shopify em curso.", status },
      { status: 409 }
    );
  }

  if (await isShopifySyncRunning(session.shop)) {
    return Response.json(
      {
        ok: false,
        error: "Aguarda que a publicação Shopify em curso termine antes do reset.",
      },
      { status: 409 }
    );
  }

  try {
    await loadOfflineSessionForShop(session.shop);
  } catch (err) {
    const message =
      err instanceof ShopifyAuthSessionError
        ? err.message
        : "Sessão Shopify inválida. Abre a app no Admin.";
    return Response.json({ ok: false, error: message, authError: true }, { status: 401 });
  }

  await initShopifyResetJob(session.shop);
  startShopifyCatalogResetInBackground(session);

  const status = await readShopifyResetStatus(session.shop);

  return Response.json({
    ok: true,
    message: "Reset do catálogo Shopify iniciado.",
    jobId: status.jobId,
    status,
  });
};
