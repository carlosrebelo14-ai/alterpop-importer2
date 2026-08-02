import { authenticateAdmin } from "../utils/authenticate.server";
import {
  isShopifySyncRunning,
  readShopifySyncStatus,
  cancelShopifySyncJob,
  initShopifySyncJob,
  failShopifySyncJob,
} from "../../lib/importer/shopify/shopifySyncJob.server.js";
import { startApprovedShopifySyncInBackground } from "../../lib/importer/shopify/shopifyApprovedSync.server.js";
import { listApprovedSkusForShopifySync } from "../../lib/curation/curationQueue.server.js";
import {
  loadOfflineSessionForShop,
  ShopifyAuthSessionError,
} from "../../lib/session/loadOfflineSessionForShop.server.js";
import { isShopifyResetRunning } from "../../lib/importer/shopify/shopifyResetJob.server.js";

/**
 * GET /api/shopify-sync — estado do job em curso (polling UI).
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const status = await readShopifySyncStatus(session.shop);
  const approvedCount = (await listApprovedSkusForShopifySync()).length;

  return Response.json({
    ok: true,
    status,
    approvedCount,
    running: status.state === "running",
  });
};

/**
 * POST /api/shopify-sync — inicia publicação dos APPROVED na Shopify ou cancela job em curso.
 */
export const action = async ({ request }) => {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticateAdmin(request);

  let customTags = [];
  let requestedSkus = null;
  let force = false;
  let clearLock = false;
  let isCancel = request.method === "DELETE";

  const url = new URL(request.url);
  if (url.searchParams.get("force") === "1") force = true;
  if (url.searchParams.get("clearLock") === "1") clearLock = true;
  if (url.searchParams.get("cancel") === "1") isCancel = true;

  try {
    const json = await request.clone().json();
    if (json.force) force = true;
    if (json.clearLock) clearLock = true;
    if (json.cancel || json.intent === "cancel") isCancel = true;
    if (Array.isArray(json.customTags)) {
      customTags = json.customTags.map(String).filter(Boolean);
    }
    if (Array.isArray(json.skus) && json.skus.length > 0) {
      requestedSkus = json.skus.map(String).filter(Boolean);
    }
  } catch {
    /* sem body */
  }

  // Handle cancellation
  if (isCancel) {
    const status = await cancelShopifySyncJob(session.shop);
    return Response.json({
      ok: true,
      message: "Importação cancelada pelo utilizador.",
      status,
    });
  }

  if (clearLock) {
    await failShopifySyncJob(session.shop, "Bloqueio libertado manualmente pelo utilizador.");
    return Response.json({ ok: true, message: "Trava de sincronização libertada." });
  }

  if (await isShopifyResetRunning(session.shop)) {
    return Response.json(
      {
        ok: false,
        error: "Aguarda que o reset do catálogo Shopify termine antes de publicar.",
      },
      { status: 409 }
    );
  }

  if (!force && (await isShopifySyncRunning(session.shop))) {
    const status = await readShopifySyncStatus(session.shop);
    return Response.json(
      {
        ok: false,
        error: "Já existe uma sincronização Shopify em curso.",
        status,
      },
      { status: 409 }
    );
  }

  let approvedSkus = await listApprovedSkusForShopifySync();
  if (requestedSkus && requestedSkus.length > 0) {
    const reqSet = new Set(requestedSkus);
    approvedSkus = approvedSkus.filter((sku) => reqSet.has(sku));
    if (!approvedSkus.length) {
      approvedSkus = requestedSkus;
    }
  }

  if (!approvedSkus.length) {
    return Response.json(
      { ok: false, error: "Nenhum produto com status APPROVED para publicar." },
      { status: 400 }
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

  await initShopifySyncJob(session.shop, approvedSkus.length);
  startApprovedShopifySyncInBackground(session, { customTags, skus: approvedSkus });

  const status = await readShopifySyncStatus(session.shop);

  return Response.json({
    ok: true,
    message: `Publicação iniciada (${approvedSkus.length} produtos).`,
    jobId: status.jobId,
    total: approvedSkus.length,
    status,
  });
};
