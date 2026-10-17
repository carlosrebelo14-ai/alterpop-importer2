import { authenticateAdmin } from "../utils/authenticate.server";
import {
  isShopifySyncRunning,
  readShopifySyncStatus,
  cancelShopifySyncJob,
  initShopifySyncJob,
  failShopifySyncJob,
} from "../../lib/importer/shopify/shopifySyncJob.server.js";
import { startApprovedShopifySyncInBackground } from "../../lib/importer/shopify/shopifyApprovedSync.server.js";
import { tentarReservarPublicacao } from "../../lib/importer/shopify/publicacaoEmCurso.js";
import { listApprovedSkusForShopifySync, loadCurationQueue } from "../../lib/curation/curationQueue.server.js";
import { resolveSyncSkus } from "../../lib/importer/shopify/resolveSyncSkus.js";
import {
  loadOfflineSessionForShop,
  ShopifyAuthSessionError,
} from "../../lib/session/loadOfflineSessionForShop.server.js";
import { isShopifyResetRunning } from "../../lib/importer/shopify/shopifyResetJob.server.js";
import { rejectCustomTags } from "../../lib/importer/shopify/tagAllowlist.js";
import { assertBulkConfirm, BulkConfirmError } from "../../lib/curation/bulkConfirm.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { assertThemeContractValid, ThemeContractError } from "../../lib/importer/shopify/themeContract.server.js";
import { readDbDegraded } from "../../lib/health/dbDegraded.js";
import { isCatalogIndexingRunning } from "../../lib/importer/catalog/indexingStream.server.js";
import {
  atividadeAppEmCurso,
  motivoDeRecusaDaPublicacaoManual,
  scriptDeIndexacaoEmCurso,
} from "../../lib/curation/atividadeApp.js";

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

  let customTagsError = null;
  let requestedSkus = null;
  let skusVazios = false;
  let skusInvalidos = false;
  let force = false;
  let confirmCount = null;
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
    if (Number.isInteger(json.confirmCount)) confirmCount = json.confirmCount;
    if (json.cancel || json.intent === "cancel") isCancel = true;
    customTagsError = rejectCustomTags(json.customTags);
    if (json.skus !== undefined && !Array.isArray(json.skus)) skusInvalidos = true;
    if (Array.isArray(json.skus)) {
      requestedSkus = json.skus.map(String).filter(Boolean);
      skusVazios = requestedSkus.length === 0;
    }
  } catch {
    /* sem body */
  }

  // Lote 1 (DBG-03): `skus` que não é lista (string, número, objeto) lia-se como ausente e publicava tudo.
  if (skusInvalidos && !isCancel) {
    return Response.json({ ok: false, error: "O campo skus tem de ser uma lista de SKUs." }, { status: 400 });
  }

  // A2 (29/09/2026): customTags recusado com erro visível — nunca ignorado em silêncio.
  if (customTagsError && !isCancel) {
    return Response.json({ ok: false, error: customTagsError }, { status: 400 });
  }

  // Lote 1 (DBG-03): `skus: []` lia-se como "todos os APPROVED". Publicar tudo pede-se sem o campo.
  if (skusVazios && !isCancel) {
    return Response.json(
      { ok: false, error: "Lista de SKUs vazia. Para publicar todos os APPROVED, não envies o campo skus." },
      { status: 400 }
    );
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

  // Modo degradado (Decisão 34): publicar recusa-se com a causa à vista. Cancelar continua a funcionar.
  const dbDegraded = readDbDegraded();
  if (dbDegraded) {
    return Response.json(
      { ok: false, error: `BD em modo degradado: ${dbDegraded.cause}`, dbDegraded },
      { status: 503 }
    );
  }

  // PR 5 (DBG-141): a publicação manual não corre com indexação do catálogo em curso, nem com a do ciclo, nem com um
  // script de reindexação vivo. A indexação esvazia o catálogo, e a publicação marcaria SYNC_ERROR "SKU ausente".
  const motivoIndexacao = motivoDeRecusaDaPublicacaoManual({
    indexacaoEmCurso: isCatalogIndexingRunning(session.shop) || atividadeAppEmCurso()?.tipo === "indexacao",
    atividadeScript: scriptDeIndexacaoEmCurso(),
  });
  if (motivoIndexacao) {
    console.log(`[shopify-sync] publicação recusada: ${motivoIndexacao}`);
    return Response.json({ ok: false, error: motivoIndexacao }, { status: 409 });
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

  // Lote 1 (DBG-03): só APPROVED. Um SKU pedido fora de APPROVED recusa o pedido inteiro, sem fallback.
  const approvedList = await listApprovedSkusForShopifySync();
  const statusBySku = requestedSkus?.length
    ? new Map((await loadCurationQueue()).items.map((i) => [i.sku, i.status]))
    : new Map();
  const resolved = resolveSyncSkus({ requested: requestedSkus, approved: approvedList, statusBySku });
  if (!resolved.ok) {
    return Response.json({ ok: false, error: resolved.error, rejected: resolved.rejected }, { status: 400 });
  }
  const approvedSkus = resolved.skus;

  if (!approvedSkus.length) {
    return Response.json(
      { ok: false, error: "Nenhum produto com status APPROVED para publicar." },
      { status: 400 }
    );
  }

  // D1: publicar acima de 50 produtos exige o número exato confirmado. Antes de qualquer
  // escrita na Shopify e antes de o job arrancar.
  try {
    assertBulkConfirm(approvedSkus.length, confirmCount, { what: "Publicar" });
  } catch (err) {
    if (err instanceof BulkConfirmError) {
      return Response.json(
        { ok: false, code: err.code, error: err.message, count: err.count, confirmed: err.confirmed },
        { status: 409 }
      );
    }
    throw err;
  }

  let offlineSession;
  try {
    offlineSession = await loadOfflineSessionForShop(session.shop);
  } catch (err) {
    const message =
      err instanceof ShopifyAuthSessionError
        ? err.message
        : "Sessão Shopify inválida. Abre a app no Admin.";
    return Response.json({ ok: false, error: message, authError: true }, { status: 401 });
  }

  // Guarda do tema (Decisão 32, só com THEME_GUARD=ON): lê o tema MAIN (só leitura) e recusa o
  // lote se o contrato estiver inválido ou a leitura falhar. Avisos nunca recusam. Antes de
  // iniciar o job, para o operador ver a causa já no toast; o motor repete a verificação.
  try {
    await assertThemeContractValid(createShopifyClientFromSession(offlineSession), session.shop, { includeFranchise: true });
  } catch (err) {
    if (err instanceof ThemeContractError) {
      return Response.json(
        { ok: false, code: err.code, error: err.message, themeContract: err.themeContract ?? null },
        { status: err.status }
      );
    }
    throw err;
  }

  // DBG-105: a reserva é tomada aqui, sem await entre ela e o initShopifySyncJob, e segue com o job até ao arranque
  // em background. Não depende de force: force só salta o gate de estado, acima. Se o ciclo já publica, responde 409.
  const reserva = tentarReservarPublicacao();
  if (!reserva) {
    return Response.json({ ok: false, error: "Já existe uma sincronização Shopify em curso." }, { status: 409 });
  }

  // PR 5 (DBG-141): a indexação pode ter arrancado nos awaits acima, depois da verificação de indexação. Confirma-se aqui,
  // sem await entre a reserva e a decisão. Uma indexação que arranque depois vê a reserva e recusa-se (indexingStream).
  const motivoDepoisDaReserva = motivoDeRecusaDaPublicacaoManual({
    indexacaoEmCurso: isCatalogIndexingRunning(session.shop) || atividadeAppEmCurso()?.tipo === "indexacao",
    atividadeScript: scriptDeIndexacaoEmCurso(),
  });
  if (motivoDepoisDaReserva) {
    reserva.libertar();
    console.log(`[shopify-sync] publicação recusada: ${motivoDepoisDaReserva}`);
    return Response.json({ ok: false, error: motivoDepoisDaReserva }, { status: 409 });
  }
  try {
    await initShopifySyncJob(session.shop, approvedSkus.length);
    startApprovedShopifySyncInBackground(session, { skus: approvedSkus, reserva });
  } catch (err) {
    reserva.libertar();
    throw err;
  }

  const status = await readShopifySyncStatus(session.shop);

  return Response.json({
    ok: true,
    message: `Publicação iniciada (${approvedSkus.length} produtos).`,
    jobId: status.jobId,
    total: approvedSkus.length,
    status,
  });
};
