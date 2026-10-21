import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import {
  lerEstadoAtualNaFila,
  listCurationQueueItems,
  loadCurationQueue,
  markQueueItemPublished,
  markQueueItemSyncError,
} from "../../curation/curationQueue.server.js";
import { marcarAtividadeApp } from "../../curation/atividadeApp.js";
import { reservarPublicacaoEntreProcessos } from "./publicacaoEmCurso.js";
import { resolveSyncSkus } from "./resolveSyncSkus.js";
import { createShopifyClientFromSession } from "../shopifyClient.js";
import {
  isShopifyAuthError,
  isShopifySessionError,
  loadOfflineSessionForShop,
  ShopifyAuthSessionError,
} from "../../session/loadOfflineSessionForShop.server.js";
import {
  clearSyncErrorForSku,
  persistSyncError,
} from "../sync/syncErrorLog.server.js";
import { publishCatalogProductToShopify } from "./shopifyProductPublisher.server.js";
import { ensureOciostockMetafieldDefinitions } from "./metafieldSetup.js";
import { assertFranchiseConditionsAligned } from "./franchiseConditionsGuard.server.js";
import { assertThemeContractValid } from "./themeContract.server.js";
import {
  completeShopifySyncJob,
  failShopifySyncJob,
  initShopifySyncJob,
  updateShopifySyncProgress,
  isShopifySyncCancelled,
} from "./shopifySyncJob.server.js";
import { createSyncJobRecord, finishSyncJobRecord } from "./syncJobHistory.server.js";
import { loadShopSettings } from "../settings.server.js";
import { resolveMarginPct } from "../pricing/pricing.server.js";
import { assertDbNotDegraded } from "../../health/dbDegraded.js";

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Aceita Location GID completo ou ID numérico.
 * @param {string | undefined | null} rawLocationId
 */
function normalizeLocationId(rawLocationId) {
  const value = String(rawLocationId || "").trim();
  if (!value) return undefined;
  if (value.startsWith("gid://shopify/Location/")) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Location/${value}`;
  return value;
}

/**
 * Tarefa 51 (Decisão 28) — antes, `safePrisma` sem `fallback` engolia qualquer erro
 * de query e devolvia `undefined`/vazio, indistinguível de "estes SKUs não existem no
 * catálogo". Uma falha de leitura transitória (contenção SQLite) fazia 6 de 8
 * produtos reais falharem com "SKU não encontrado", quando na verdade a query nunca
 * chegou a correr com sucesso. Agora `rethrow: true` — erro de query propaga e aborta
 * o LOTE INTEIRO (ver chamada em runApprovedShopifySync), nunca vira SYNC_ERROR
 * por produto. "0 linhas" continua a significar genuinamente ausência do catálogo.
 * @param {string} shop
 * @param {string[]} skus
 */
async function loadCatalogRowsBySkus(shop, skus) {
  if (!skus.length) return [];
  return safePrisma(
    "shopifySync.catalogProducts",
    () =>
      prisma.catalogProduct.findMany({
        where: { shop, sku: { in: skus } },
      }),
    { rethrow: true }
  );
}

/**
 * Dependências reais do motor. `opts.dependencias` substitui só as chaves que trouxer, e só os testes
 * o usam: em produção o objeto de opções não traz nada e corre o código real. Serve para o teste de
 * Decisão 2 controlar o momento da criação com um publicador falso, sem rede nem base de dados.
 */
const DEPENDENCIAS_REAIS = {
  publicar: publishCatalogProductToShopify,
  sessaoOffline: loadOfflineSessionForShop,
  verificarFranquias: assertFranchiseConditionsAligned,
  verificarTema: assertThemeContractValid,
  garantirMetafields: ensureOciostockMetafieldDefinitions,
  carregarCatalogo: loadCatalogRowsBySkus,
};

/**
 * Motor de publicação — lotes de 10, 1s entre lotes, nunca interrompe o job inteiro.
 * @param {{ shop: string, accessToken: string }} session
 */
/**
 * @param {{ shop: string, accessToken: string }} session
 * @param {{ skipInit?: boolean, customTags?: string[], skus?: string[] }} [opts]
 */
/**
 * Override de preço da curadoria que o publisher não aplicou (produto já existia na
 * Shopify com preço): fica no registo de sync que a UI já mostra, depois do clear do
 * publish com sucesso — nunca uma perda silenciosa (revisão adversarial do PR #87).
 */
async function recordPriceNotice(shop, sku, result, jobId) {
  if (!result?.priceNotice) return;
  await persistSyncError({ shop, sku, reason: result.priceNotice, type: "price_notice", jobId }).catch((err) => {
    console.error(`[shopify-sync] registo do aviso de preço falhou para ${sku}:`, err?.message || err);
  });
}

/**
 * Leitura do estado da fila falhou antes de criar um produto. Não é falha de publicação (Decisão 30):
 * a releitura aborta a corrida e o item fica APPROVED, sem SYNC_ERROR.
 */
class ErroDeLeituraDaFila extends Error {
  /** @param {string} sku @param {unknown} causa */
  constructor(sku, causa) {
    super(`leitura do estado de ${sku} falhou antes de publicar: ${causa?.message || causa}`);
    this.name = "ErroDeLeituraDaFila";
  }
}

/**
 * Decisão 2 (DBG-04): compara o estado relido antes de criar o produto. Se a decisão humana mudou durante
 * a corrida, o produto não é criado. O SKU fica registado como saltado e o estado não se toca. A releitura
 * é feita pelo chamador, fora do try de publicação.
 * @param {string | null} estado estado do SKU na fila no momento da releitura
 * @returns {Promise<boolean>} true se o SKU foi saltado
 */
async function saltarSeDecisaoHumana(shop, sku, jobId, estado) {
  if (estado === "APPROVED") return false;
  const motivo = "saltado: decisão humana durante a corrida";
  console.log(`[shopify-sync] ${sku} ${motivo} (estado atual: ${estado ?? "sem entrada na fila"}).`);
  await persistSyncError({ shop, sku, reason: motivo, type: "validation", jobId }).catch((err) => {
    console.error(`[shopify-sync] registo do salto falhou para ${sku}:`, err?.message || err);
  });
  return true;
}

/**
 * Publicação Shopify. Marca a atividade enquanto corre, para que os scripts que escrevem a fila
 * recusem (Decisão 35, D7). O marcador sai sempre, mesmo em erro.
 * Exclusão mútua (DBG-105): a rota reserva antes de chamar e passa a reserva em opts.reserva. Sem reserva, esta
 * corrida reserva aqui. Sem reserva disponível, não publica. A reserva sai sempre, mesmo em erro.
 */
export async function runApprovedShopifySync(session, opts = {}) {
  // DBG-142: sem reserva de quem chama (scripts), toma-se a reserva entre processos. Ocupada, a publicação recusa-se.
  const reserva = opts.reserva ?? (await reservarPublicacaoEntreProcessos());
  if (!reserva) return { ok: false, skipped: true, reason: "publish_already_running" };
  let retirar = () => {};
  try {
    retirar = marcarAtividadeApp({ tipo: "publicacao" });
    return await runApprovedShopifySyncCore(session, opts);
  } finally {
    retirar();
    await reserva.libertar();
  }
}

async function runApprovedShopifySyncCore(session, opts = {}) {
  const shop = session.shop;
  const dep = { ...DEPENDENCIAS_REAIS, ...(opts.dependencias || {}) };
  // Modo degradado (Decisão 34): nenhum publish. O job falha à vista, em vez de ficar em "running".
  try {
    assertDbNotDegraded("publicação Shopify");
  } catch (err) {
    await failShopifySyncJob(shop, err.message);
    throw err;
  }
  const approved = (await listCurationQueueItems("APPROVED")).map((i) => i.sku);
  let uniqueSkus = [...new Set(approved)];

  if (Array.isArray(opts.skus) && opts.skus.length > 0) {
    // Lote 1 (DBG-03): só APPROVED. Um SKU pedido fora de APPROVED recusa o lote inteiro, sem fallback.
    const queue = await loadCurationQueue();
    const statusBySku = new Map(queue.items.map((i) => [i.sku, i.status]));
    const resolved = resolveSyncSkus({ requested: opts.skus, approved: uniqueSkus, statusBySku });
    if (!resolved.ok) {
      // A rota pode já ter criado o job: falha-o, para não ficar em 'running'.
      await failShopifySyncJob(shop, resolved.error);
      return { ok: false, error: resolved.error, rejected: resolved.rejected };
    }
    uniqueSkus = resolved.skus;
  }

  if (!uniqueSkus.length) {
    return { ok: false, error: "Nenhum produto com status APPROVED na fila de curadoria." };
  }

  if (!opts.skipInit) {
    await initShopifySyncJob(shop, uniqueSkus.length);
  }

  // Histórico persistido (item 16) — independente do jobId de shopifySyncJob.server.js
  // (que às vezes nem chega a ser criado no caminho do relógio, ver skipInit sempre
  // true em startApprovedShopifySyncInBackground). Gerado sempre, mesmo com skipInit,
  // para toda corrida ficar registada e os erros individuais poderem referenciá-la.
  const syncHistoryJobId = `syncjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await createSyncJobRecord(syncHistoryJobId, shop, uniqueSkus.length);

  // Tarefa 51 (Decisão 28) — leitura do catálogo depois do histórico já existir, para
  // uma falha de query poder seguir o MESMO padrão de abort das falhas de auth/guarda
  // abaixo (failShopifySyncJob + finishSyncJobRecord + throw), em vez de degradar
  // silenciosamente em "SKU não encontrado" por produto.
  let catalogRows;
  try {
    catalogRows = await dep.carregarCatalogo(shop, uniqueSkus);
  } catch (err) {
    const message = "Falha de leitura do catálogo (SQLite) — corrida abortada, nenhum produto processado.";
    await failShopifySyncJob(shop, message);
    await finishSyncJobRecord(syncHistoryJobId, { succeeded: 0, failed: 0, status: "failed" });
    throw err;
  }
  const rowBySku = new Map(catalogRows.map((r) => [r.sku, r]));

  const work = uniqueSkus.map((sku) => ({
    sku,
    row: rowBySku.get(sku) || null,
  }));

  let offlineSession;
  try {
    offlineSession = await dep.sessaoOffline(shop);
  } catch (err) {
    const message =
      err instanceof ShopifyAuthSessionError
        ? err.message
        : "Autenticação Shopify inválida. Abre a app no Admin.";
    await failShopifySyncJob(shop, message);
    await finishSyncJobRecord(syncHistoryJobId, { succeeded: 0, failed: 0, status: "failed" });
    throw err;
  }

  const client = createShopifyClientFromSession(offlineSession);

  // Tarefa 26 — portão obrigatório: aborta ANTES de qualquer escrita de metafields se
  // a tabela de universos/Lines não bater com as coleções reais da loja (universo
  // ativo sem coleção, coleção órfã sem entrada na tabela, condição/templateSuffix
  // errado). Corre uma vez por lote, não por produto.
  try {
    await dep.verificarFranquias(client);
  } catch (err) {
    await failShopifySyncJob(shop, err.message);
    await finishSyncJobRecord(syncHistoryJobId, { succeeded: 0, failed: 0, status: "failed" });
    throw err;
  }

  // Decisão 32 — guarda do tema (só com THEME_GUARD=ON): lê o tema MAIN, só leitura, e aborta o
  // lote se o contrato estiver inválido (template em falta, definição sem acesso storefront) ou
  // se a leitura falhar. A guarda de franquias acima já cobre handles e regras de Universe/Line.
  // Avisos do tema (settings, secções, filtros) nunca abortam.
  try {
    await dep.verificarTema(client, shop, { includeFranchise: false });
  } catch (err) {
    await failShopifySyncJob(shop, err.message);
    await finishSyncJobRecord(syncHistoryJobId, { succeeded: 0, failed: 0, status: "failed" });
    throw err;
  }

  // Definições e margem global — lidas uma vez por job. Ficheiro ilegível ou margem
  // inválida abortam o job com a mensagem à vista (failShopifySyncJob), nunca um job
  // preso em "running" nem um publish com preço por defeito.
  let shopSettings;
  let marginPct;
  try {
    shopSettings = await loadShopSettings(shop);
    marginPct = resolveMarginPct(shopSettings);
  } catch (err) {
    await failShopifySyncJob(shop, err.message);
    await finishSyncJobRecord(syncHistoryJobId, { succeeded: 0, failed: 0, status: "failed" });
    throw err;
  }
  const locationId = normalizeLocationId(
    shopSettings.locationId?.trim() || process.env.SHOPIFY_LOCATION_ID?.trim() || undefined
  );
  const variantCache = new Map();

  // Estava hardcoded a `false`, o que silenciosamente impedia QUALQUER escrita de
  // metafield por este caminho (o publisher tem `if (metafieldReady)`) — nem o
  // ociostock.net_price, que existe desde o início, nem o ociostock.dimensions.
  // Bug encontrado a 2026-08-05. Falha aqui não impede o publish: sem definições
  // os produtos vão na mesma, apenas sem metafields.
  let metafieldReady = false;
  try {
    metafieldReady = await dep.garantirMetafields(client, null);
  } catch (err) {
    console.warn(
      "[shopify-sync] definições de metafield indisponíveis, publish continua sem elas:",
      err?.message || err
    );
  }

  let published = 0;
  let failed = 0;
  let processed = 0;
  // Decisão 2: SKU saltado por decisão humana durante a corrida. Não conta como falha.
  let saltados = 0;
  /** @type {{ sku: string, message: string }[]} */
  const recentErrors = [];

  try {
    for (let i = 0; i < work.length; i += BATCH_SIZE) {
      if (isShopifySyncCancelled(shop)) {
        console.log(`[shopifySync] Sync cancelado pelo utilizador para ${shop}.`);
        break;
      }

      const batch = work.slice(i, i + BATCH_SIZE);

      for (const item of batch) {
        if (isShopifySyncCancelled(shop)) break;

        processed += 1;
        await updateShopifySyncProgress(shop, {
          processed,
          published,
          failed,
          currentSku: item.sku,
          recentErrors: recentErrors.slice(-20),
        });

        if (!item.row) {
          failed += 1;
          // Tarefa 51 — chegar aqui só é possível com 0 linhas genuínas (query já
          // teria abortado o lote inteiro se tivesse falhado). Mensagem distinta da
          // de falha de leitura, de propósito — não são a mesma classe de problema.
          const message = "SKU ausente do catálogo indexado";
          recentErrors.push({ sku: item.sku, message });
          await markQueueItemSyncError(item.sku, message);
          await persistSyncError({
            shop,
            sku: item.sku,
            reason: message,
            type: "validation",
            jobId: syncHistoryJobId,
          });
          continue;
        }

        // Decisões 2 e 30: a releitura fica fora do try de publicação. Um erro de leitura não é falha de
        // publicação: aborta a corrida (o item fica APPROVED, sem SYNC_ERROR) e a corrida devolve o erro.
        const estadoAtual = await lerEstadoAtualNaFila(item.sku);
        try {
          if (await saltarSeDecisaoHumana(shop, item.sku, syncHistoryJobId, estadoAtual)) {
            saltados += 1;
            continue;
          }
          const result = await dep.publicar(client, item.row, {
            variantCache,
            metafieldReady,
            locationId,
            customTags: opts.customTags,
            stockBuffer: shopSettings.stockBuffer,
            marginPct,
          });

          await markQueueItemPublished(item.sku, result.shopifyProductId, {
            costAtPublish: item.row?.netPrice ?? null,
            lastPriceWrite: result.lastPriceWrite ?? null,
          });
          await clearSyncErrorForSku(shop, item.sku);
          await recordPriceNotice(shop, item.sku, result, syncHistoryJobId);
          published += 1;
        } catch (err) {
          failed += 1;
          let message = err?.message || String(err);

          // Só sessão inválida/expirada justifica retry — scope em falta não desaparece
          // recarregando a sessão, e repetir cegamente aqui reusa o variantCache já
          // "envenenado" com o resultado negativo da procura anterior, criando um
          // segundo produto Shopify para o mesmo SKU.
          if (isShopifySessionError(err) && offlineSession) {
            try {
              offlineSession = await dep.sessaoOffline(shop);
              const retryClient = createShopifyClientFromSession(offlineSession);
              // Releitura desta nova tentativa. Um erro de leitura sobe como ErroDeLeituraDaFila e aborta a
              // corrida, em vez de virar SYNC_ERROR no catch abaixo.
              const estadoRetry = await lerEstadoAtualNaFila(item.sku).catch((causa) => {
                throw new ErroDeLeituraDaFila(item.sku, causa);
              });
              if (await saltarSeDecisaoHumana(shop, item.sku, syncHistoryJobId, estadoRetry)) {
                failed -= 1;
                saltados += 1;
                continue;
              }
              const result = await dep.publicar(
                retryClient,
                item.row,
                { variantCache, metafieldReady, locationId, stockBuffer: shopSettings.stockBuffer, marginPct }
              );
              await markQueueItemPublished(item.sku, result.shopifyProductId, {
            costAtPublish: item.row?.netPrice ?? null,
            lastPriceWrite: result.lastPriceWrite ?? null,
          });
              await clearSyncErrorForSku(shop, item.sku);
              await recordPriceNotice(shop, item.sku, result, syncHistoryJobId);
              published += 1;
              // NÃO faz recentErrors.pop() aqui — o push para ESTE item só acontece mais
              // abaixo (fora deste bloco), quando o retry falha. Neste ponto (retry com
              // sucesso) ainda não há nenhuma entrada deste SKU em recentErrors; um pop()
              // remove por engano a última entrada de outro SKU não relacionado que tenha
              // falhado antes neste mesmo lote (bug encontrado no code review, 2026-08-12).
              failed -= 1;
              continue;
            } catch (retryErr) {
              if (retryErr instanceof ErroDeLeituraDaFila) throw retryErr;
              message = retryErr?.message || message;
            }
          }

          recentErrors.push({ sku: item.sku, message });
          await markQueueItemSyncError(item.sku, message);
          await persistSyncError({
            shop,
            sku: item.sku,
            reason: message,
            type: isShopifyAuthError(err) ? "auth" : "product",
            jobId: syncHistoryJobId,
          });
          console.error(`[shopify-sync] Falha SKU ${item.sku}:`, message);

          if (isShopifyAuthError(err)) {
            await failShopifySyncJob(
              shop,
              `${message} Reabre a app no Admin Shopify e volta a publicar.`
            );
            break;
          }
        }
      }

      if (i + BATCH_SIZE < work.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    const status = await completeShopifySyncJob(shop, {
      published,
      failed,
      recentErrors: recentErrors.slice(-50),
    });

    await finishSyncJobRecord(syncHistoryJobId, {
      succeeded: published,
      failed,
      status: "completed",
    });

    return {
      ok: true,
      jobId: status.jobId,
      total: work.length,
      published,
      failed,
      saltados,
      recentErrors: status.recentErrors,
    };
  } catch (err) {
    await failShopifySyncJob(shop, err?.message || String(err));
    await finishSyncJobRecord(syncHistoryJobId, {
      succeeded: published,
      failed,
      status: "failed",
    });
    throw err;
  }
}

/**
 * @param {{ shop: string, accessToken: string }} session
 * @param {{ customTags?: string[], skus?: string[], reserva?: { libertar: () => void } }} [opts]
 */
export function startApprovedShopifySyncInBackground(session, opts = {}) {
  setImmediate(() => {
    runApprovedShopifySync(session, {
      skipInit: true,
      customTags: opts.customTags,
      skus: opts.skus,
      reserva: opts.reserva,
    }).catch((err) => {
      console.error("[shopify-sync] Job fatal:", err?.message || err);
    });
  });
}
