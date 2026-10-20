import {
  applyDeletedInAdmin,
  invalidateCurationMemoryCache,
  loadCurationQueue,
  mutateCurationQueue,
} from "../../curation/curationQueue.server.js";
import { marcarAtividadeApp } from "../../curation/atividadeApp.js";
import { readDbDegraded } from "../../health/dbDegraded.js";
import { createShopifyClientFromSession } from "../shopifyClient.js";
import {
  isShopifyAuthError,
  loadOfflineSessionForShop,
} from "../../session/loadOfflineSessionForShop.server.js";
import {
  completeShopifyResetJob,
  failShopifyResetJob,
  initShopifyResetJob,
  readShopifyResetStatus,
  updateShopifyResetProgress,
} from "./shopifyResetJob.server.js";
import { tentarReservarPublicacao } from "./publicacaoEmCurso.js";
import { ALTERPOP_APP_TAGS } from "./shopifyMapper.server.js";
import { deactivateAllSyncErrors } from "../sync/syncErrorLog.server.js";

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;
/** D38 (Decisão 35): este número de falhas seguidas de apagamento para o reset. */
const LIMITE_FALHAS_SEGUIDAS = 3;

const ALL_PRODUCTS = `
  query AllShopProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        tags
        variants(first: 5) {
          nodes {
            sku
          }
        }
      }
    }
  }
`;

const PRODUCTS_BY_TAG = `
  query AlterpopProductsByTag($query: String!, $first: Int!, $after: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        tags
        variants(first: 3) {
          nodes {
            sku
          }
        }
      }
    }
  }
`;

const PRODUCT_DELETE = `
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors {
        field
        message
      }
    }
  }
`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PRODUCTS_COUNT = `
  query ShopifyProductsCount {
    productsCount {
      count
    }
  }
`;

function numero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Contagem rápida de produtos na loja (pré-visualização no modal e contagem da purga).
 * @param {{ shop: string, accessToken: string }} session
 */
export async function countShopifyProductsForReset(session) {
  const offline = await loadOfflineSessionForShop(session.shop);
  const client = createShopifyClientFromSession(offline);
  return contarProdutosLoja(client);
}

/**
 * Segunda leitura da contagem, com o cliente já aberto (D37 e verificação final).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
async function contarProdutosLoja(client) {
  const data = await client.graphql(PRODUCTS_COUNT);
  return numero(data.productsCount?.count);
}

/**
 * Lista TODOS os produtos da loja (paginação GraphQL).
 * DBG-30 (2.7 (4)): uma página sem `products` ou sem `pageInfo` não é fim de lista. Lista parcial recusa-se.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {(count: number) => void} [onPage]
 */
async function listAllShopifyProducts(client, onPage) {
  /** @type {Map<string, { id: string, title: string, sku: string|null, tags: string[] }>} */
  const byId = new Map();
  let cursor = null;

  do {
    const data = await client.graphql(ALL_PRODUCTS, {
      first: 250,
      after: cursor,
    });

    const products = data?.products;
    if (!products || !products.pageInfo) {
      throw new Error(
        "A Shopify devolveu uma página de produtos sem products ou pageInfo. Lista parcial recusada: nada foi apagado."
      );
    }

    for (const node of products.nodes || []) {
      const sku =
        node.variants?.nodes?.find((v) => v?.sku)?.sku ||
        node.variants?.nodes?.[0]?.sku ||
        null;
      byId.set(node.id, {
        id: node.id,
        title: node.title || node.id,
        sku,
        tags: node.tags || [],
      });
    }

    const pageInfo = products.pageInfo;
    if (pageInfo.hasNextPage && !pageInfo.endCursor) {
      throw new Error("A Shopify indicou mais páginas sem cursor. Lista parcial recusada: nada foi apagado.");
    }
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    onPage?.(byId.size);
  } while (cursor);

  return [...byId.values()];
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} tag
 */
async function listProductsWithTag(client, tag) {
  /** @type {Map<string, { id: string, title: string, sku: string|null, tags: string[] }>} */
  const byId = new Map();
  let cursor = null;

  do {
    const safeTag = String(tag || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const data = await client.graphql(PRODUCTS_BY_TAG, {
      query: `tag:"${safeTag}"`,
      first: 100,
      after: cursor,
    });

    for (const node of data.products?.nodes || []) {
      const sku =
        node.variants?.nodes?.find((v) => v?.sku)?.sku ||
        node.variants?.nodes?.[0]?.sku ||
        null;
      byId.set(node.id, {
        id: node.id,
        title: node.title || node.id,
        sku,
        tags: node.tags || [],
      });
    }

    const pageInfo = data.products?.pageInfo;
    cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);

  return [...byId.values()];
}

/**
 * Produtos conhecidos pela fila local (PUBLISHED / SYNC_ERROR com GID Shopify).
 */
async function listProductsFromCurationQueue() {
  const queue = await loadCurationQueue();
  /** @type {Map<string, { id: string, title: string, sku: string|null }>} */
  const byId = new Map();

  for (const item of queue.items) {
    const productId = item.metadata?.shopifyProductId;
    if (!productId) continue;
    if (item.status !== "PUBLISHED" && item.status !== "SYNC_ERROR") continue;
    byId.set(String(productId), {
      id: String(productId),
      title: item.title_en || item.sku,
      sku: item.sku,
    });
  }

  return [...byId.values()];
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 */
async function deleteShopifyProduct(client, productId) {
  const data = await client.graphql(PRODUCT_DELETE, {
    input: { id: productId },
  });
  const errors = data.productDelete?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.productDelete?.deletedProductId || productId;
}

/**
 * D2 (DBG-72, Decisão 35): uma decisão humana tomada depois do arranque do reset (statusChangedAt posterior) ganha
 * sobre o apagamento. O reset não a reescreve.
 * @param {{ statusChangedAt?: string|null }} item
 * @param {number|null} desde instante de arranque do reset, em ms
 */
function decidiuUmHumano(item, desde) {
  if (desde === null || !item.statusChangedAt) return false;
  const quando = Date.parse(item.statusChangedAt);
  return Number.isFinite(quando) && quando > desde;
}

/**
 * Repõe toda a fila local publicada para `targetStatus` e limpa o vínculo Shopify (shopifyProductId, publishedAt,
 * sync errors). Devolve o número de itens revertidos.
 *
 * `targetStatus`:
 *  - "APPROVED" (default) — reset de emergência clássico: os produtos voltam ao pool de publicação automática.
 *  - "PENDING" — devolve à curadoria: saem do pool de publicação, nada é re-publicado sem aprovação explícita.
 *
 * @param {{ targetStatus?: "APPROVED" | "PENDING", exceptSkus?: string[], exceptIds?: string[], deletedInAdmin?: boolean, desde?: string }} [opts]
 */
export async function revertAllPublishedInQueue(opts = {}) {
  const relatorio = await revertAllPublishedInQueueComRelatorio(opts);
  return relatorio.valor;
}

/**
 * Igual a revertAllPublishedInQueue, com o que ficou de fora: decisões humanas (D2) e SYNC_ERROR preservado (D44).
 * @param {{ targetStatus?: "APPROVED" | "PENDING", exceptSkus?: string[], exceptIds?: string[], deletedInAdmin?: boolean, desde?: string }} [opts]
 * @returns {Promise<{ valor: number, decisoesHumanas: number, sincroErro: number }>}
 */
export async function revertAllPublishedInQueueComRelatorio(opts = {}) {
  // Decisão 35 (D3): a escrita da fila passa pelo lock do processo principal, sobre a fila lida de novo.
  return mutateCurationQueue((queue) => {
    const relatorio = reverterTodosPublicados(queue, opts);
    return { gravar: relatorio.valor > 0, valor: relatorio };
  });
}

/**
 * @param {{ items: any[] }} queue
 * @param {{ targetStatus?: string, exceptSkus?: string[], exceptIds?: string[], deletedInAdmin?: boolean, desde?: string }} opts
 * @returns {{ valor: number, decisoesHumanas: number, sincroErro: number }}
 */
function reverterTodosPublicados(queue, opts) {
  const targetStatus = opts.targetStatus === "PENDING" ? "PENDING" : "APPROVED";
  const exceptSkus = new Set(opts.exceptSkus || []);
  const exceptIds = new Set((opts.exceptIds || []).map(String));
  const desde = opts.desde ? Date.parse(opts.desde) : null;
  // Um instante para a reposição inteira. O flush do worker compara statusChangedAt com a sua leitura (D2).
  const now = new Date().toISOString();
  let reverted = 0;
  let decisoesHumanas = 0;
  let sincroErro = 0;

  for (const item of queue.items) {
    // D44 (Decisão 35) e D11 (Decisão 29): o reset deixa SYNC_ERROR como está e lista-o. Nunca o põe em PENDING.
    if (item.status === "SYNC_ERROR") {
      sincroErro += 1;
      continue;
    }
    const pid = item.metadata?.shopifyProductId;
    if (item.status !== "PUBLISHED" && !pid) continue;

    // Apagamento falhado: fica PUBLISHED com o vínculo à Shopify (revisão do Lote 1, ponto 1).
    // DBG-30 (2.8 (7)): com id, o id decide. Um SKU repetido noutro produto não pode poupar este item.
    const falhou = pid ? exceptIds.has(String(pid)) : exceptSkus.has(item.sku);
    if (falhou) continue;

    if (decidiuUmHumano(item, desde)) {
      decisoesHumanas += 1;
      continue;
    }

    if (opts.deletedInAdmin) {
      applyDeletedInAdmin(item, now);
      // Decisão 5: o reset congela o item como decisão humana (origem "reset"), fora das regras e da elite.
      item.metadata = { ...item.metadata, origem: "reset" };
      reverted += 1;
      continue;
    }

    item.status = targetStatus;
    item.statusChangedAt = now;
    item.shopifyStatus = "ACTIVE";
    item.metadata = {
      ...item.metadata,
      shopifyProductId: null,
      publishedAt: null,
      shopifyResetAt: now,
      syncError: null,
      syncErrorAt: null,
      // Decisão 5: o reset congela o item como decisão humana (origem "reset"), fora das regras e da elite.
      origem: "reset",
    };
    reverted += 1;
  }

  return { valor: reverted, decisoesHumanas, sincroErro };
}

/**
 * Produto apagado com sucesso na Shopify: PUBLISHED → PENDING, retido, pela regra de 09/10/2026.
 * Nunca volta a APPROVED sozinho. Limpa o id da Shopify (fica em deletedInAdmin).
 * @param {string[]} skus
 * @param {string[]} productIds
 * @param {{ desde?: string }} [opts]
 */
export async function revertLocalAfterShopifyReset(skus = [], productIds = [], opts = {}) {
  const desde = opts.desde ? Date.parse(opts.desde) : null;
  // Decisão 35 (D3): a escrita da fila passa pelo lock do processo principal, sobre a fila lida de novo.
  return mutateCurationQueue((queue) => {
    const skuSet = new Set(skus.filter(Boolean));
    const idSet = new Set(productIds.filter(Boolean));
    let reverted = 0;
    let decisoesHumanas = 0;

    for (const item of queue.items) {
      const pid = item.metadata?.shopifyProductId;
      // Com id ligado, o id manda: um SKU repetido noutro produto não pode arrastar este item.
      const match = pid ? idSet.has(String(pid)) : skuSet.has(item.sku);
      if (!match) continue;
      // D44 e D11: SYNC_ERROR não se mexe.
      if (item.status === "SYNC_ERROR") continue;
      if (item.status !== "PUBLISHED" && !pid) continue;
      // D2 (DBG-72): decisão humana depois do arranque do reset ganha.
      if (decidiuUmHumano(item, desde)) {
        decisoesHumanas += 1;
        continue;
      }

      applyDeletedInAdmin(item, new Date().toISOString());
      // Decisão 5: origem "reset", como no reset em massa.
      item.metadata = { ...item.metadata, origem: "reset" };
      reverted += 1;
    }

    if (decisoesHumanas > 0) {
      // Só contagens: os SKUs não vão para logs.
      console.warn(`[shopify-reset] ${decisoesHumanas} item(ns) com decisão humana durante o reset: não revertidos.`);
    }
    return { gravar: reverted > 0, valor: reverted };
  });
}

/**
 * Lista produtos a apagar no reset de emergência.
 * Por defeito: TODOS os produtos da loja Shopify (não só tags alterpop).
 * @param {{ shop: string, accessToken: string }} session
 * @param {{ scope?: 'all' | 'app_tags', onListProgress?: (count: number) => void }} [opts]
 */
export async function collectProductsForShopifyReset(session, opts = {}) {
  const scope = opts.scope || "all";
  const onListProgress = opts.onListProgress;
  const offline = await loadOfflineSessionForShop(session.shop);
  const client = createShopifyClientFromSession(offline);

  /** @type {Map<string, { id: string, title: string, sku: string|null, tags?: string[] }>} */
  const merged = new Map();

  if (scope === "all") {
    const all = await listAllShopifyProducts(client, (count) => {
      onListProgress?.(count);
    });
    for (const p of all) merged.set(p.id, p);
    console.log(`[shopify-reset] ${merged.size} produto(s) na loja Shopify.`);
  } else {
    for (const tag of ALTERPOP_APP_TAGS) {
      const tagged = await listProductsWithTag(client, tag);
      for (const p of tagged) merged.set(p.id, p);
    }
  }

  // Com a loja inteira listada, um id da fila que não aparece na loja já não existe na Shopify:
  // não há nada a apagar, e a varredura final trata-o como apagado (regra de 09/10). Só no scope
  // por tags se juntam os ids da fila, porque aí a loja não está toda listada.
  if (scope !== "all") {
    for (const p of await listProductsFromCurationQueue()) {
      merged.set(p.id, p);
    }
  }

  return {
    client,
    products: [...merged.values()],
    scope,
  };
}

/** @deprecated Use collectProductsForShopifyReset */
export const collectAlterpopShopifyProducts = collectProductsForShopifyReset;

/** D38 / D35: o que se regista quando o reset para. */
function resumoDoEstado(contadores, recentErrors) {
  return {
    deleted: contadores.deleted,
    failed: contadores.failed,
    revertedLocal: contadores.revertedLocal,
    recentErrors: recentErrors.slice(-50),
  };
}

/**
 * DBG-30 e DBG-72. Contagem em modo de leitura: lista a loja, e diz quantos itens da fila passariam a PENDING.
 * Não escreve: não toca no estado do reset, na fila nem na Shopify.
 * @param {{ shop: string, accessToken: string }} session
 */
async function planearResetSemEscrever(session) {
  const { products } = await collectProductsForShopifyReset(session, { scope: "all" });
  const queue = await loadCurationQueue();
  const copia = structuredClone(queue);
  const plano = reverterTodosPublicados(copia, { deletedInAdmin: true, exceptSkus: [], exceptIds: [] });
  return {
    ok: true,
    dryRun: true,
    produtosNaLoja: products.length,
    entradasParaPending: plano.valor,
    sincroErroPreservado: plano.sincroErro,
  };
}

/**
 * Verificação final (DBG-30, o critério do arquiteto): zero produtos na loja e zero PUBLISHED na fila. Se falhar, o
 * reset não fica concluído.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
async function verificarFimDoReset(client) {
  const restantes = await contarProdutosLoja(client);
  const queue = await loadCurationQueue();
  const publicados = queue.items.filter((item) => item.status === "PUBLISHED").length;
  if (restantes !== 0 || publicados !== 0) {
    throw new Error(
      `Verificação final: ${restantes} produto(s) na loja e ${publicados} PUBLISHED na fila. O reset não fica concluído.`
    );
  }
  return { restantes, publicados };
}

/**
 * Apaga em lotes de 20 com delay; reverte estado local após cada sucesso.
 *
 * opts:
 *  - skipInit: a rota já arrancou o job (initShopifyResetJob).
 *  - reservaTomada: a rota já tomou a reserva da publicação. Sem isto, o motor toma-a aqui, e recusa-se se houver
 *    publicação ou reset em curso (PR 5, DBG-140; a purga CLI corre assim).
 *  - dryRun: só conta (produtos na loja e entradas da fila que passariam a PENDING). Não escreve.
 *
 * @param {{ shop: string, accessToken: string }} session
 * @param {{ skipInit?: boolean, reservaTomada?: boolean, dryRun?: boolean }} [opts]
 */
export async function runShopifyCatalogReset(session, opts = {}) {
  if (opts.dryRun) return planearResetSemEscrever(session);
  if (opts.reservaTomada) return correrReset(session, opts);

  const reserva = tentarReservarPublicacao({
    marcar: () => marcarAtividadeApp({ tipo: "publicacao" }),
  });
  if (!reserva) {
    throw new Error("Já há uma publicação ou um reset Shopify em curso.");
  }
  try {
    return await correrReset(session, opts);
  } finally {
    reserva.libertar();
  }
}

async function correrReset(session, opts) {
  const shop = session.shop;

  if (!opts.skipInit) {
    await initShopifyResetJob(shop);
  }

  // Contadores e instante de arranque vêm do job: numa retomada (D39), o apagado e o revertido não se contam outra vez.
  const job = await readShopifyResetStatus(shop);
  const desde = job.startedAt || null;
  let deleted = numero(job.deleted);
  let revertedLocal = numero(job.revertedLocal);
  let failed = 0;
  let processed = 0;
  let falhasSeguidas = 0;
  let falhaRegistada = false;
  /** @type {{ productId: string, message: string }[]} */
  const recentErrors = [];

  try {
    await updateShopifyResetProgress(shop, { state: "listing", currentTitle: "A listar…" });

    const { client, products } = await collectProductsForShopifyReset(session, {
      scope: "all",
      onListProgress: (count) => {
        updateShopifyResetProgress(shop, {
          state: "listing",
          total: count,
          processed: 0,
          currentTitle: `A listar… ${count} produto(s)`,
        }).catch(() => {});
      },
    });
    const total = products.length;

    if (total === 0) {
      // D37 (Decisão 35): loja vazia só se confirma com uma segunda leitura a zero. Então corre a varredura.
      const segunda = await contarProdutosLoja(client);
      if (segunda !== 0) {
        throw new Error(
          `A listagem veio vazia mas a contagem da loja deu ${segunda}. Reset parado: nada foi apagado.`
        );
      }
      revertedLocal += await revertAllPublishedInQueue({ deletedInAdmin: true, desde });
      await deactivateAllSyncErrors(shop).catch(() => {});
      await verificarFimDoReset(client);
      await completeShopifyResetJob(shop, resumoDoEstado({ deleted, failed, revertedLocal }, recentErrors));
      return { ok: true, total: 0, deleted, failed, revertedLocal };
    }

    await updateShopifyResetProgress(shop, {
      state: "deleting",
      total,
      processed: 0,
      deleted,
      failed: 0,
    });

    console.log(`[shopify-reset] A apagar ${total} produto(s) na Shopify (catálogo completo)…`);

    // Apagamentos falhados: ficam PUBLISHED, com o vínculo à Shopify, e não entram no sweep final.
    const falhas = { skus: new Set(), ids: new Set() };

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);

      for (const product of batch) {
        processed += 1;
        // Batimento (D39): cada produto renova o estado antes do apagamento.
        await updateShopifyResetProgress(shop, {
          state: "deleting",
          total,
          processed,
          deleted,
          failed,
          revertedLocal,
          currentTitle: product.title,
          recentErrors: recentErrors.slice(-20),
        });

        // D36 (Decisão 35): o modo degradado trava o reset antes de cada apagamento, dentro do motor.
        const degradado = readDbDegraded();
        if (degradado) {
          throw new Error(
            `BD em modo degradado (${degradado.cause ?? "causa desconhecida"}). Reset parado antes do próximo apagamento.`
          );
        }

        try {
          await deleteShopifyProduct(client, product.id);
        } catch (err) {
          const message = err?.message || String(err);
          failed += 1;
          if (product.sku) falhas.skus.add(product.sku);
          falhas.ids.add(product.id);
          recentErrors.push({ productId: product.id, sku: product.sku ?? null, message });
          console.error(`[shopify-reset] Falha de apagamento (${processed} de ${total}):`, message);

          if (isShopifyAuthError(err)) {
            // DBG-30 (2.7 (3)): aviso de auth em texto próprio. O catch externo não o sobrescreve.
            falhaRegistada = true;
            await failShopifyResetJob(
              shop,
              `A Shopify recusou o acesso: ${message}. Reabre a app no Admin para renovar a sessão e tenta novamente.`,
              resumoDoEstado({ deleted, failed, revertedLocal }, recentErrors)
            );
            throw err;
          }

          // D38 (Decisão 35): três falhas seguidas param o reset.
          falhasSeguidas += 1;
          if (falhasSeguidas >= LIMITE_FALHAS_SEGUIDAS) {
            throw new Error(
              `${LIMITE_FALHAS_SEGUIDAS} falhas seguidas de apagamento na Shopify: reset parado (Decisão 35, D38).`
            );
          }
          continue;
        }

        falhasSeguidas = 0;
        // Apagado na Shopify: conta já. A gravação local vem a seguir.
        deleted += 1;
        try {
          revertedLocal += await revertLocalAfterShopifyReset(
            product.sku ? [product.sku] : [],
            [product.id],
            { desde }
          );
        } catch (err) {
          // D35 (Decisão 35): a primeira falha de gravação local depois de um apagamento para o reset. O produto
          // já saiu da Shopify: o item fica PUBLISHED com o vínculo, e a retomada ou a varredura fecham-no.
          invalidateCurationMemoryCache();
          throw new Error(
            `Fila local não gravou depois de apagar na Shopify: reset parado (D35). ${err?.message || err}`
          );
        }
      }

      if (i + BATCH_SIZE < products.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // Sweep final: o que sobra PUBLISHED (sem produto na Shopify) segue a mesma regra de 09/10.
    // Os apagamentos falhados ficam de fora. Com id ligado, o id decide (DBG-30, 2.8 (7)).
    const varredura = await revertAllPublishedInQueueComRelatorio({
      deletedInAdmin: true,
      exceptSkus: [...falhas.skus],
      exceptIds: [...falhas.ids],
      desde,
    });
    revertedLocal += varredura.valor;

    // Estado local reposto para republicação limpa (ver indexingStream.server.js).
    await deactivateAllSyncErrors(shop).catch(() => {});

    await verificarFimDoReset(client);

    await completeShopifyResetJob(shop, resumoDoEstado({ deleted, failed, revertedLocal }, recentErrors));

    console.log(
      `[shopify-reset] Concluído: ${deleted} apagado(s), ${failed} falha(s), ${revertedLocal} revertido(s) na fila local.`
    );

    return {
      ok: true,
      total,
      deleted,
      failed,
      revertedLocal,
      decisoesHumanas: varredura.decisoesHumanas,
      sincroErroPreservado: varredura.sincroErro,
    };
  } catch (err) {
    if (!falhaRegistada) {
      await failShopifyResetJob(
        shop,
        err?.message || String(err),
        resumoDoEstado({ deleted, failed, revertedLocal }, recentErrors)
      );
    }
    throw err;
  }
}

/**
 * Arranque em background. A rota já tomou a reserva da publicação e a liberta quando o reset acaba.
 * @param {object} session
 * @param {{ reserva?: { libertar: () => void } }} [opts]
 */
export function startShopifyCatalogResetInBackground(session, opts = {}) {
  setImmediate(() => {
    runShopifyCatalogReset(session, { skipInit: true, reservaTomada: true })
      .catch((err) => {
        console.error("[shopify-reset] Job fatal:", err?.message || err);
      })
      .finally(() => opts.reserva?.libertar());
  });
}

