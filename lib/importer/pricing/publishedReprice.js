/**
 * "Aplicar aos publicados" — classificação (briefing, passo 3). Módulo puro, sem I/O:
 * a leitura da Shopify e a escrita estão em publishedReprice.server.js.
 *
 * Mudar a margem nunca mexe na loja. Esta ação é a única que reescreve o preço de um
 * produto já publicado, com pré-visualização e confirmação.
 *
 * Categorias de uma linha:
 *   update     preço da loja ≠ proposto e é o último que a app escreveu → pode escrever-se
 *   conforme   preço da loja = proposto
 *   ignored    preço manual preservado (inclui o override da curadoria, salvo `includeManual`),
 *              produto trancado (sync_locked) ou sem última escrita
 *   notFound   o produto já não existe na loja (provado por product(id)) → volta a PENDING
 *   failed     não foi possível decidir (sem preço calculado, SKU duplicado, produto sem
 *              variante com o SKU, existência por provar)
 * Na execução, `update` passa a `updated` ou `failed`. A soma das cinco = o âmbito.
 */
import { evaluatePrice, MIN_MARGIN, PRICE_STATUS, PRICE_RULE } from "./pricing.server.js";
import { isManualPrice, changeReasons } from "./lastPriceWrite.js";

export const REPRICE_CATEGORIES = Object.freeze(["update", "conforme", "ignored", "notFound", "failed"]);

const cents = (n) => Math.round(Number(n) * 100);
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Que limite da regra decidiu o preço proposto.
 * @param {string|null} priceStatus estado de pricing.server.js
 * @param {number|null} marginPct margem usada
 * @param {"NET"|"LEGACY"} [rule] NET não tem pisos nem tetos
 * @returns {string}
 */
export function activeLimit(priceStatus, marginPct, rule) {
  if (rule === PRICE_RULE.NET) return "—";
  if (priceStatus === PRICE_STATUS.ACIMA_PVPR) return "piso de custo + 10%";
  if (priceStatus === PRICE_STATUS.TETO) return "TETO";
  if (priceStatus === PRICE_STATUS.PISO_PVPR) return "PISO_PVPR";
  if (priceStatus === PRICE_STATUS.SEM_PVPR) return "SEM_PVPR";
  // Margem abaixo de MIN_MARGIN aplica o piso de custo + 10 % (effectiveMarginPct).
  if (marginPct != null && marginPct < MIN_MARGIN) return "piso de custo + 10%";
  return priceStatus || "—";
}

/**
 * @typedef {{
 *   sku: string, title: string|null, category: 'update'|'conforme'|'ignored'|'notFound'|'failed',
 *   reason: string|null, livePrice: number|null, proposed: number|null,
 *   diff: number|null, diffPct: number|null, reasons: string[], limit: string|null,
 *   marginPct: number|null, marginInferred: boolean, cost: number|null, pvpr: number|null,
 *   priceStatus: string|null, productId: string|null, variantId: string|null,
 *   rule: 'NET'|'LEGACY'|null, manualOverride: boolean,
 * }} RepriceRow
 */

/**
 * @param {{
 *   item: { sku: string, title_en?: string, metadata?: { lastPriceWrite?: object|null, shopifyProductId?: string|null } },
 *   catalog: { distributorPrice: number|null, grossPrice: number|null }|null|undefined,
 *   live: { price: number, variantId?: string, productId?: string, duplicate?: boolean, syncLocked?: boolean }|null|undefined,
 *   productExists?: boolean|null,
 *   existsDetail?: string|null,
 *   globalPct: number,
 *   rule?: 'NET'|'LEGACY',
 *   includeManual?: boolean,
 * }} args `rule` calcula numa regra pedida sem mudar a global (pré-visualização com rule=NET);
 *   `includeManual` inclui os produtos com preço manual (override da curadoria), fora por omissão.
 *   productExists só conta quando não há variante live: false = provado que não existe;
 *   true = existe; null/undefined = por provar (existsDetail diz porquê).
 * @returns {RepriceRow}
 */
export function classifyRepriceRow({ item, catalog, live, productExists, existsDetail, globalPct, rule, includeManual = false }) {
  const last = item.metadata?.lastPriceWrite || null;
  const manualOverride = Number(item.metadata?.overrides?.price) > 0;
  /** @type {RepriceRow} */
  const row = {
    sku: item.sku,
    title: item.title_en ?? null,
    category: "failed",
    reason: null,
    livePrice: live && Number.isFinite(Number(live.price)) ? Number(live.price) : null,
    proposed: null,
    diff: null,
    diffPct: null,
    reasons: [],
    limit: null,
    marginPct: null,
    marginInferred: Boolean(last?.marginInferred),
    cost: null,
    pvpr: null,
    priceStatus: null,
    productId: live?.productId ?? null,
    variantId: live?.variantId ?? null,
    rule: null,
    manualOverride,
    ignoreCode: null,
  };
  const out = (category, reason, ignoreCode = null) => ({ ...row, category, reason, ignoreCode });

  if (!live) {
    if (productExists === false) return out("notFound", "produto apagado na loja — volta a PENDING");
    if (productExists === true) return out("failed", "o produto existe mas nenhuma variante tem este SKU (SKU mudado fora da app)");
    return out("failed", `não foi possível provar que o produto não existe${existsDetail ? `: ${existsDetail}` : ""}`);
  }
  if (live.duplicate) return out("failed", "SKU em mais de uma variante na loja");
  if (row.livePrice == null || row.livePrice <= 0) return out("failed", `preço na loja inválido (${live.price})`);
  if (!catalog) return out("failed", "SKU fora do catálogo indexado — sem custo nem PVPR para calcular");

  const priced = evaluatePrice(catalog.distributorPrice, catalog.grossPrice, globalPct, { metadata: item.metadata }, { rule });
  row.rule = priced.rule;
  if (priced.priceError || priced.finalPrice == null) {
    return out("failed", `sem preço calculado: ${priced.priceError || "sem resultado"}`);
  }
  row.proposed = priced.finalPrice;
  row.marginPct = priced.marginPct;
  row.cost = priced.cost;
  row.pvpr = priced.pvpr;
  row.priceStatus = priced.priceStatus;
  row.limit = activeLimit(priced.priceStatus, priced.marginPct, priced.rule);
  row.diff = round2(row.proposed - row.livePrice);
  row.diffPct = round2(((row.proposed - row.livePrice) / row.livePrice) * 100);
  row.reasons = changeReasons(last, { cost: priced.cost, pvpr: priced.pvpr, marginPct: priced.marginPct, rule: priced.rule });

  if (cents(row.livePrice) === cents(row.proposed)) return out("conforme", null);
  if (live.syncLocked) return out("ignored", "produto trancado (ociostock.sync_locked) — preço preservado", "locked");

  // Preço manual fixado na curadoria (overrides.price, com autor/data/motivo em priceMeta):
  // preservado, fora de "Aplicar aos publicados" salvo pedido expresso (includeManual).
  if (manualOverride && !includeManual) return out("ignored", "preço manual preservado (override da curadoria)", "manualOverride");

  const manual = isManualPrice(last, row.livePrice);
  if (manual === null) return out("ignored", "sem última escrita registada — não se sabe se o preço é da app", "noRecord");
  if (manual === true) return out("ignored", "preço manual preservado", "manualDetected");
  return out("update", null);
}

/**
 * Totais do topo da pré-visualização. Subir/descer e a soma contam só as linhas `update`.
 * @param {RepriceRow[]} rows
 */
export function summarizeReprice(rows) {
  const counts = Object.fromEntries(REPRICE_CATEGORIES.map((c) => [c, 0]));
  let ups = 0;
  let downs = 0;
  let sumDiff = 0;
  /** Fora por preço manual: override da curadoria ou preço da loja que já não é o da última escrita da app. */
  let manualExcluded = 0;
  for (const r of rows) {
    counts[r.category] += 1;
    if (r.category === "ignored" && (r.ignoreCode === "manualOverride" || r.ignoreCode === "manualDetected")) manualExcluded += 1;
    if (r.category !== "update") continue;
    if (r.diff > 0) ups += 1;
    else if (r.diff < 0) downs += 1;
    sumDiff += r.diff;
  }
  return { total: rows.length, counts, ups, downs, sumDiff: round2(sumDiff), manualExcluded };
}
