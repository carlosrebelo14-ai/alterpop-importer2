import crypto from "node:crypto";
import {
  isCatalogIndexingRunning,
  startCatalogIndexingWorker,
} from "../../lib/importer/catalog/indexingStream.server.js";
import { readCatalogRebuildStatus } from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { runApprovedShopifySync } from "../../lib/importer/shopify/shopifyApprovedSync.server.js";
import { syncPublishedStockLevels } from "../../lib/importer/shopify/publishedStockSync.server.js";
import { isShopifySyncRunning } from "../../lib/importer/shopify/shopifySyncJob.server.js";
import { listApprovedSkusForShopifySync } from "../../lib/curation/curationQueue.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { ensureOciostockMetafieldDefinitions } from "../../lib/importer/shopify/metafieldSetup.js";

/**
 * POST /api/trigger-sync — dispara indexação + publicação sem sessão OAuth.
 *
 * Existe para a máquina-relógio (app Fly `alterpop-sync-clock`) poder acordar o ciclo
 * periodicamente. NÃO usa autenticação Shopify: quem chama é uma máquina, não um browser.
 *
 * SEGURANÇA
 * - Segredo partilhado em `SYNC_TRIGGER_SECRET` (Fly secret, nunca no fly.toml).
 * - Sem segredo configurado o endpoint fica FECHADO (503) — falha segura: um deploy que
 *   perca a env var não abre o endpoint ao mundo.
 * - Comparação em tempo constante (timingSafeEqual) para não vazar o segredo byte a byte
 *   através da duração da resposta.
 * - Resposta 401 é sempre idêntica, sem distinguir "sem header" de "header errado".
 *
 * ASSÍNCRONO por desenho: o ciclo completo (download de ~71 MB + indexação de ~30k
 * produtos + publish) leva vários minutos, muito acima do timeout do proxy da Fly.
 * Responde 202 assim que arranca e o chamador não espera pelo fim — o progresso real
 * consulta-se em /api/catalog-status e /api/shopify-sync.
 */

const JSON_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Content-Type": "application/json; charset=utf-8",
};

/** Espera máxima pela indexação antes de desistir do publish (indexação típica: ~6 min). */
const INDEXING_TIMEOUT_MS = 40 * 60 * 1000;
const INDEXING_POLL_MS = 10 * 1000;

/** Comparação em tempo constante, tolerante a comprimentos diferentes. */
function secretMatches(provided, expected) {
  if (typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual exige comprimentos iguais; compara hashes para normalizar sem
  // revelar o comprimento do segredo pela via do erro.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const unauthorized = () =>
  Response.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: JSON_HEADERS });

export const loader = () =>
  Response.json(
    { ok: false, error: "Method not allowed" },
    { status: 405, headers: JSON_HEADERS }
  );

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method not allowed" },
      { status: 405, headers: JSON_HEADERS }
    );
  }

  const expected = process.env.SYNC_TRIGGER_SECRET;
  if (!expected) {
    console.warn("[trigger-sync] SYNC_TRIGGER_SECRET não configurado — endpoint fechado.");
    return Response.json(
      { ok: false, error: "Trigger endpoint not configured" },
      { status: 503, headers: JSON_HEADERS }
    );
  }

  if (!secretMatches(request.headers.get("X-Sync-Token"), expected)) {
    return unauthorized();
  }

  const shop = process.env.SHOPIFY_SHOP_URL;
  if (!shop) {
    return Response.json(
      { ok: false, error: "SHOPIFY_SHOP_URL not configured" },
      { status: 503, headers: JSON_HEADERS }
    );
  }

  // Nunca sobrepor ciclos: uma segunda indexação sobre a mesma BD corromperia contagens
  // e duplicaria trabalho. 409 é resposta normal para o relógio, não erro.
  // `skipped: true` distingue "não havia nada a fazer" de "correu mal" — o relógio usa
  // este campo para não registar um ciclo saltado como falha nos seus logs.
  if (isCatalogIndexingRunning(shop)) {
    console.log("[trigger-sync] ciclo saltado: indexação já em curso.");
    return Response.json(
      { ok: true, skipped: true, reason: "indexing_already_running" },
      { status: 409, headers: JSON_HEADERS }
    );
  }
  if (await isShopifySyncRunning(shop)) {
    console.log("[trigger-sync] ciclo saltado: publicação já em curso.");
    return Response.json(
      { ok: true, skipped: true, reason: "publish_already_running" },
      { status: 409, headers: JSON_HEADERS }
    );
  }

  let session;
  try {
    session = await loadOfflineSessionForShop(shop);
  } catch (err) {
    console.error("[trigger-sync] sessão indisponível:", err?.message || err);
    return Response.json(
      { ok: false, error: "Shopify session unavailable" },
      { status: 503, headers: JSON_HEADERS }
    );
  }

  const settings = await loadShopSettings(shop);
  const startedAt = new Date().toISOString();

  // Arranca em background e devolve já — o ciclo demora minutos.
  //
  // ATENÇÃO: startCatalogIndexingWorker devolve ANTES de terminar (o trabalho corre num
  // IIFE destacado) — daí o polling explícito antes de publicar sobre um catálogo já
  // completo. Dentro do IIFE, runApprovedShopifySync e syncPublishedStockLevels (item
  // 18b) correm sequencialmente com await — não bloqueiam a resposta HTTP (já foi
  // devolvida antes disto), só garantem que não disputam a API da Shopify ao mesmo tempo.
  void (async () => {
    try {
      console.log(`[trigger-sync] ciclo iniciado @ ${startedAt}`);
      await startCatalogIndexingWorker(shop, settings, { runPurge: false, resume: false });

      const deadline = Date.now() + INDEXING_TIMEOUT_MS;
      while (isCatalogIndexingRunning(shop)) {
        if (Date.now() > deadline) {
          console.error("[trigger-sync] indexação excedeu o tempo limite — publish cancelado.");
          return;
        }
        await new Promise((r) => setTimeout(r, INDEXING_POLL_MS));
      }

      const status = await readCatalogRebuildStatus(shop);
      if (status.error) {
        console.error(`[trigger-sync] indexação terminou com erro (${status.error}) — publish cancelado.`);
        return;
      }

      console.log(`[trigger-sync] indexação concluída (${status.totalRows ?? "?"} linhas).`);

      // Garante que as definições de metafield existem (ociostock.net_price e
      // ociostock.dimensions) — na primeira execução automática ninguém abriu o Admin
      // para as criar. Falha aqui não impede o publish: as definições são um extra,
      // não um pré-requisito para criar produtos.
      try {
        const client = createShopifyClientFromSession(session);
        await ensureOciostockMetafieldDefinitions(client, null);
        console.log("[trigger-sync] definições de metafield garantidas.");
      } catch (err) {
        console.warn("[trigger-sync] definições de metafield falharam:", err?.message || err);
      }

      console.log("[trigger-sync] a publicar aprovados…");
      try {
        await runApprovedShopifySync(session, { skipInit: true });
        console.log("[trigger-sync] publicação de aprovados concluída.");
      } catch (err) {
        console.error("[trigger-sync] publicação de aprovados falhou:", err?.message || err);
      }

      // Item 5 — coleções automáticas por licença. Corre depois do publish (precisa
      // de ver os PUBLISHED mais recentes) e nunca bloqueia nem falha o ciclo; a
      // coleção fica sempre em rascunho (ver aviso de segurança no módulo).
      try {
        const collectionsClient = createShopifyClientFromSession(session);
        const { checkAndCreateLicenceCollections } = await import(
          "../../lib/importer/shopify/autoCollections.server.js"
        );
        await checkAndCreateLicenceCollections(collectionsClient, shop);
      } catch (err) {
        console.warn("[trigger-sync] coleções automáticas por licença falharam:", err?.message || err);
      }

      // Item 18b — produtos já PUBLISHED não entram no runApprovedShopifySync acima
      // (esse só processa status APPROVED). Sem isto, um produto que esgota e o
      // fornecedor repõe stock ficava preso a "sem stock" na Shopify até alguém o
      // reaprovar manualmente. Corre sempre a seguir ao publish normal, nunca em
      // paralelo — evita as duas rotinas disputarem o mesmo variantCache/rate limit.
      try {
        const stockClient = createShopifyClientFromSession(session);
        const stockResult = await syncPublishedStockLevels(stockClient, shop, {
          stockBuffer: settings.stockBuffer,
        });
        console.log(
          `[trigger-sync] stock de publicados: ${stockResult.checked} verificados, ${stockResult.updated} atualizados, ${stockResult.skipped} sem alteração, ${stockResult.failed} falhas.`
        );
      } catch (err) {
        console.error("[trigger-sync] sync de stock de publicados falhou:", err?.message || err);
      }
    } catch (err) {
      console.error("[trigger-sync] ciclo falhou:", err?.message || err);
    }
  })();

  const approvedCount = (await listApprovedSkusForShopifySync()).length;
  return Response.json(
    { ok: true, accepted: true, startedAt, shop, approvedCount },
    { status: 202, headers: JSON_HEADERS }
  );
};
