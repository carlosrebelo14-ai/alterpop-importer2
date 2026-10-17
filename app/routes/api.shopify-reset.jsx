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
import { readDbDegraded } from "../../lib/health/dbDegraded.js";
import { isCatalogIndexingRunning } from "../../lib/importer/catalog/indexingStream.server.js";
import { atividadeAppEmCurso, marcarAtividadeApp, motivoDeRecusaDoReset } from "../../lib/curation/atividadeApp.js";
import { tentarReservarPublicacao } from "../../lib/importer/shopify/publicacaoEmCurso.js";

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

  // Modo degradado (Decisão 34): o reset apaga produtos na Shopify. Recusa-se antes de qualquer chamada.
  const dbDegraded = readDbDegraded();
  if (dbDegraded) {
    return Response.json(
      { ok: false, error: `BD em modo degradado: ${dbDegraded.cause}`, dbDegraded },
      { status: 503 }
    );
  }

  // Decisão 35 (D3): o reset reverte a fila e não corre com indexação em curso (409).
  const motivoRecusa = motivoDeRecusaDoReset({
    indexacaoEmCurso: isCatalogIndexingRunning(session.shop),
    atividade: atividadeAppEmCurso(),
  });
  if (motivoRecusa) {
    return Response.json({ ok: false, error: motivoRecusa }, { status: 409 });
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

  // PR 5 (DBG-140): o reset toma a reserva da publicação, de forma síncrona. O ciclo publica sem gravar running,
  // por isso o estado do job não o vê. A reserva vê o ciclo e a publicação manual. Sai no fim do reset.
  // PR 5 (revisão): a reserva e a marca da app nascem no mesmo passo síncrono.
  let reserva = null;
  try {
    reserva = tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) });
  } catch {
    return Response.json(
      { ok: false, error: "Não foi possível marcar a atividade da app. Nada foi gravado." },
      { status: 503 }
    );
  }
  if (!reserva) {
    // Pode ser uma publicação (manual ou do ciclo) ou um reset que ainda não gravou o estado (pedido em paralelo).
    return Response.json(
      { ok: false, error: "Já há uma publicação ou um reset Shopify em curso. Aguarda que termine antes do reset." },
      { status: 409 }
    );
  }

  // PR 5 (revisão): a indexação pode ter arrancado nos awaits acima. Confirma-se com a reserva na mão.
  try {
    const motivoDepoisDaReserva = motivoDeRecusaDoReset({
      indexacaoEmCurso: isCatalogIndexingRunning(session.shop),
      atividade: atividadeAppEmCurso(),
    });
    if (motivoDepoisDaReserva) {
      reserva.libertar();
      return Response.json({ ok: false, error: motivoDepoisDaReserva }, { status: 409 });
    }
  } catch (err) {
    reserva.libertar();
    throw err;
  }

  try {
    await loadOfflineSessionForShop(session.shop);
  } catch (err) {
    reserva.libertar();
    const message =
      err instanceof ShopifyAuthSessionError
        ? err.message
        : "Sessão Shopify inválida. Abre a app no Admin.";
    return Response.json({ ok: false, error: message, authError: true }, { status: 401 });
  }

  try {
    await initShopifyResetJob(session.shop);
  } catch (err) {
    reserva.libertar();
    throw err;
  }
  startShopifyCatalogResetInBackground(session, { reserva });

  const status = await readShopifyResetStatus(session.shop);

  return Response.json({
    ok: true,
    message: "Reset do catálogo Shopify iniciado.",
    jobId: status.jobId,
    status,
  });
};
