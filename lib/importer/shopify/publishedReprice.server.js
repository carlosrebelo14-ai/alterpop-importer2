/**
 * "Aplicar aos publicados" — pré-visualização e execução (briefing, passos 4 e 6).
 *
 * Mudar a margem nunca mexe na loja; esta ação separada é a única que reescreve o preço de
 * produtos já publicados. Nada é escrito antes da confirmação, e a confirmação traz o número
 * exato do âmbito: se o âmbito mudou entretanto, recusa.
 *
 * A classificação (cinco categorias) é de publishedReprice.js. Aqui: ler a fila, o
 * catálogo e a loja; escrever com compare-and-set e releitura; gravar a última escrita.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../prisma/prismaSafe.server.js";
import {
  loadCurationQueue,
  recordLastPriceWrites,
  markQueueItemDeletedInAdmin,
} from "../../curation/curationQueue.server.js";
import { loadShopSettings } from "../settings.server.js";
import { resolveMarginPct } from "../pricing/pricing.server.js";
import { buildLastPriceWrite } from "../pricing/lastPriceWrite.js";
import { classifyRepriceRow, summarizeReprice, REPRICE_CATEGORIES } from "../pricing/publishedReprice.js";
import { fetchLiveVariantsBySku } from "./liveVariantsBySku.server.js";
import { isShopifySyncRunning } from "./shopifySyncJob.server.js";

/** Acima disto a confirmação é obrigatória e traz número, filtro e amostra (passo D1). */
export const CONFIRM_THRESHOLD = 50;
const PAUSE_MS = 250;

const PRODUCT_EXISTS = `
  query RepriceProductExists($id: ID!) {
    product(id: $id) { id }
  }
`;
const VARIANT_PRICE_UPDATE = `
  mutation RepriceVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;
const VARIANT_RECHECK = `
  query RepriceRecheck($id: ID!) {
    productVariant(id: $id) {
      price
      product { syncLocked: metafield(namespace: "ociostock", key: "sync_locked") { value } }
    }
  }
`;

export class RepriceError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "RepriceError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const cents = (v) => Math.round(Number(v) * 100);
const sleep = (ms) => new Promise((r) => (ms > 0 ? setTimeout(r, ms) : r()));

function appendErrors(entries) {
  if (!entries.length) return;
  const file = path.join(process.cwd(), "results", "errors.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    list = [];
  }
  list.push(...entries);
  fs.writeFileSync(file, JSON.stringify(list, null, 2), "utf8");
}
const errorEntry = (codigo, sku, mensagem, contexto = {}) => ({
  operacao: "published-reprice",
  codigo,
  mensagem,
  timestamp: new Date().toISOString(),
  contexto: { sku, ...contexto },
});

async function defaultLoadCatalog(shop, skus) {
  const rows = await prisma.catalogProduct.findMany({
    where: { shop, sku: { in: skus } },
    select: { sku: true, distributorPrice: true, grossPrice: true },
  });
  return new Map(rows.map((r) => [r.sku, r]));
}

/**
 * Pré-visualização: lê tudo no momento (preço na loja incluído) e classifica. Não escreve.
 * Âmbito: `rule` = publicados com a regra desatualizada (tudo menos os conformes);
 * `filter` = publicados dos `skus` do filtro atual do painel, conformes incluídos.
 * @param {{ shop: string, client: import('../shopifyClient.js').ShopifyClient, mode: 'rule'|'filter',
 *   skus?: string[], deps?: object }} args
 */
export async function buildRepricePreview({ shop, client, mode, skus = [], deps = {} }) {
  if (mode !== "rule" && mode !== "filter") throw new RepriceError("BAD_MODE", `Âmbito inválido: ${mode}`);
  const queue = await (deps.loadQueue || loadCurationQueue)();
  const published = queue.items.filter((i) => i.status === "PUBLISHED");
  const filterSet = mode === "filter" ? new Set(skus) : null;
  const items = filterSet ? published.filter((i) => filterSet.has(i.sku)) : published;

  const globalPct = deps.globalPct ?? resolveMarginPct(await loadShopSettings(shop));
  const itemSkus = items.map((i) => i.sku);
  const catalogBySku = await (deps.loadCatalog || defaultLoadCatalog)(shop, itemSkus);
  // Lança se um chunk falhar: uma lista incompleta faria publicados parecerem apagados.
  const liveBySku = await (deps.fetchLive || ((list) => fetchLiveVariantsBySku(client, list)))(itemSkus);

  const rows = [];
  for (const item of items) {
    const live = liveBySku.get(item.sku);
    let productExists = null;
    let existsDetail = null;
    if (!live) {
      const pid = item.metadata?.shopifyProductId;
      if (!pid) existsDetail = "PUBLISHED na fila sem shopifyProductId guardado";
      else {
        try {
          productExists = Boolean((await client.graphql(PRODUCT_EXISTS, { id: pid })).product);
        } catch (err) {
          existsDetail = err?.message || String(err);
        }
      }
    }
    rows.push(classifyRepriceRow({ item, catalog: catalogBySku.get(item.sku), live, productExists, existsDetail, globalPct }));
  }

  const all = rows;
  const scopeRows = mode === "rule" ? all.filter((r) => r.category !== "conforme") : all;
  return {
    mode,
    globalPct,
    publishedTotal: published.length,
    outdatedTotal: all.filter((r) => r.category !== "conforme").length,
    filterSkus: filterSet ? filterSet.size : null,
    notPublishedInFilter: filterSet ? filterSet.size - items.length : 0,
    rows: scopeRows,
    totals: summarizeReprice(scopeRows),
    readAt: new Date().toISOString(),
  };
}

/**
 * Execução. Recusa com um ciclo de sync a correr, sem confirmação do número exato do
 * âmbito, ou com o âmbito diferente do mostrado. Cada preço: compare-and-set, escrita,
 * releitura; só então conta como atualizado e grava a última escrita.
 * @param {{ shop: string, client: import('../shopifyClient.js').ShopifyClient, mode: 'rule'|'filter',
 *   skus?: string[], confirmCount: number, deps?: object }} args
 */
export async function executeReprice({ shop, client, mode, skus = [], confirmCount, deps = {} }) {
  const running = await (deps.isSyncRunning || isShopifySyncRunning)(shop);
  if (running) {
    throw new RepriceError("SYNC_RUNNING", "Há um ciclo de sync a correr — espera que termine antes de atualizar preços.");
  }
  if (!Number.isInteger(confirmCount)) {
    throw new RepriceError("CONFIRM_REQUIRED", "Falta a confirmação com o número de produtos do âmbito.");
  }

  const preview = await buildRepricePreview({ shop, client, mode, skus, deps });
  const scope = preview.rows.length;
  if (confirmCount !== scope) {
    throw new RepriceError(
      "SCOPE_CHANGED",
      `O âmbito mudou desde a pré-visualização: confirmaste ${confirmCount} produto(s), agora são ${scope}. Volta a pré-visualizar.`,
      { confirmed: confirmCount, now: scope }
    );
  }

  const pause = deps.pauseMs ?? PAUSE_MS;
  const errors = [];
  /** @type {Array<import('../pricing/publishedReprice.js').RepriceRow & { outcome: string, error?: string|null }>} */
  const results = [];
  const toRecord = [];

  for (const row of preview.rows) {
    if (row.category === "conforme") {
      results.push({ ...row, outcome: "conforme" });
      continue;
    }
    if (row.category === "ignored") {
      results.push({ ...row, outcome: "ignored", error: row.reason });
      continue;
    }
    if (row.category === "failed") {
      errors.push(errorEntry("NOT_DECIDABLE", row.sku, row.reason));
      results.push({ ...row, outcome: "failed", error: row.reason });
      continue;
    }
    if (row.category === "notFound") {
      try {
        const marked = await markQueueItemDeletedInAdmin(row.sku);
        if (!marked) throw new Error("SKU saiu da fila durante a operação");
        results.push({ ...row, outcome: "notFound" });
      } catch (err) {
        const msg = `não foi possível devolver a PENDING: ${err?.message || err}`;
        errors.push(errorEntry("MARK_DELETED_FAILED", row.sku, msg));
        results.push({ ...row, outcome: "failed", error: msg });
      }
      continue;
    }

    // update — compare-and-set: o preço da loja tem de ser ainda o da pré-visualização.
    try {
      const current = (await client.graphql(VARIANT_RECHECK, { id: row.variantId })).productVariant;
      if (!current) throw new Error("a variante desapareceu da loja durante a operação");
      if (current.product?.syncLocked?.value === "true") {
        results.push({ ...row, outcome: "ignored", error: "ficou trancado (sync_locked) durante a operação" });
        continue;
      }
      if (cents(current.price) !== cents(row.livePrice)) {
        if (cents(current.price) === cents(row.proposed)) results.push({ ...row, outcome: "conforme" });
        else results.push({ ...row, outcome: "ignored", error: `o preço mudou na loja durante a operação (${current.price}) — preservado` });
        continue;
      }
      const data = await client.graphql(VARIANT_PRICE_UPDATE, {
        productId: row.productId,
        variants: [{ id: row.variantId, price: row.proposed.toFixed(2) }],
      });
      const userErrors = data.productVariantsBulkUpdate?.userErrors || [];
      if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join("; "));
      const after = (await client.graphql(VARIANT_RECHECK, { id: row.variantId })).productVariant;
      if (!after || cents(after.price) !== cents(row.proposed)) {
        throw new Error(`releitura diferente: a loja tem ${after?.price ?? "nada"}, escreveu-se ${row.proposed.toFixed(2)}`);
      }
      results.push({ ...row, outcome: "updated" });
      toRecord.push({
        sku: row.sku,
        write: buildLastPriceWrite({
          price: row.proposed,
          cost: row.cost,
          pvpr: row.pvpr,
          marginPct: row.marginPct,
          priceStatus: row.priceStatus,
          source: "reprice",
        }),
      });
    } catch (err) {
      const msg = err?.message || String(err);
      errors.push(errorEntry("WRITE_FAILED", row.sku, msg, { before: row.livePrice, after: row.proposed }));
      results.push({ ...row, outcome: "failed", error: msg });
    }
    await sleep(pause);
  }

  // Última escrita dos atualizados numa só passagem. Preço escrito sem registo é dito alto.
  let recordFailures = [];
  if (toRecord.length) {
    try {
      const rec = await recordLastPriceWrites(toRecord);
      recordFailures = rec.missing;
    } catch (err) {
      recordFailures = toRecord.map((e) => e.sku);
      errors.push(errorEntry("RECORD_LAST_WRITE_FAILED", null, err?.message || String(err), { skus: recordFailures }));
    }
    for (const sku of recordFailures) {
      errors.push(errorEntry("LAST_WRITE_NOT_RECORDED", sku, "preço escrito na loja mas a última escrita não foi gravada"));
    }
  }
  appendErrors(errors);

  const count = (o) => results.filter((r) => r.outcome === o).length;
  const summary = {
    scope,
    updated: count("updated"),
    conformes: count("conforme"),
    ignored: count("ignored"),
    failed: count("failed"),
    notFound: count("notFound"),
  };
  const sum = summary.updated + summary.conformes + summary.ignored + summary.failed + summary.notFound;
  if (sum !== scope) {
    throw new RepriceError("SUM_MISMATCH", `Erro interno: as categorias somam ${sum} e o âmbito é ${scope}.`, { summary });
  }
  return { ...summary, recordFailures, rows: results, readAt: preview.readAt };
}

export { REPRICE_CATEGORIES };
