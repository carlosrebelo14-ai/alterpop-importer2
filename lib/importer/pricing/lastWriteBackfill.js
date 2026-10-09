/**
 * Preenchimento inicial da última escrita (briefing "Aplicar aos publicados", passo 2).
 *
 * Os publicados de hoje foram escritos antes de existir o registo. Assume-se que o preço
 * live é o que a app escreveu (sem preço manual) e grava-se como última escrita, com a
 * margem ESTIMADA a partir da regra (intervalo, ver inferMarginPct). O Carlos confirma a
 * lista antes de gravar. Módulo puro: o script lê a fila, a Shopify e o catálogo.
 */
import { tryPriceProduct } from "./pricing.server.js";
import { buildLastPriceWrite, inferMarginPct } from "./lastPriceWrite.js";

/**
 * @typedef {{ sku: string, action: 'RECORD'|'SKIP', reason: string|null, livePrice: number|null,
 *   cost: number|null, pvpr: number|null, marginPct: number|null, range: [number, number]|null,
 *   ambiguous: boolean, priceStatus: string|null, ruleNow: number|null, write: object|null }} BackfillRow
 */

/**
 * @param {{
 *   items: Array<{ sku: string, metadata?: { lastPriceWrite?: object|null } }>,
 *   liveBySku: Map<string, { price: number, duplicate?: boolean, syncLocked?: boolean }>,
 *   catalogBySku: Map<string, { distributorPrice: number|null, grossPrice: number|null }>,
 *   globalPct: number,
 *   skip?: Set<string>,
 *   assumeMargin?: number|null,
 *   now?: Date,
 * }} args
 * @returns {BackfillRow[]}
 */
export function planLastWriteBackfill({ items, liveBySku, catalogBySku, globalPct, skip = new Set(), assumeMargin = null, now = new Date() }) {
  return items.map((item) => {
    const sku = item.sku;
    const base = { sku, livePrice: null, cost: null, pvpr: null, marginPct: null, range: null, ambiguous: false, priceStatus: null, ruleNow: null, write: null };
    const skipRow = (reason) => ({ ...base, action: "SKIP", reason });

    if (item.metadata?.lastPriceWrite) return skipRow("já tem última escrita");
    if (skip.has(sku)) return skipRow("excluído pelo Carlos (--skip)");

    const live = liveBySku.get(sku);
    if (!live) return skipRow("sem variante live com este SKU — produto apagado ou SKU mudado");
    if (live.duplicate) return skipRow("SKU em mais de uma variante live");
    if (!Number.isFinite(live.price) || live.price <= 0) return skipRow(`preço live inválido (${live.price})`);

    const cat = catalogBySku.get(sku);
    if (!cat) return { ...skipRow("SKU fora do catálogo indexado — sem custo nem PVPR"), livePrice: live.price };

    const priceAt = (m) => tryPriceProduct(cat.distributorPrice, cat.grossPrice, m).finalPrice;
    const now0 = tryPriceProduct(cat.distributorPrice, cat.grossPrice, globalPct);
    if (now0.priceError) return { ...skipRow(`sem preço calculado: ${now0.priceError}`), livePrice: live.price };

    const inferred = inferMarginPct(priceAt, live.price);
    const statusAt = (m) => tryPriceProduct(cat.distributorPrice, cat.grossPrice, m).priceStatus;

    // Margem a gravar:
    //  - --assume-margin N (a margem global que o Carlos sabe ter estado ativa) quando N está
    //    no intervalo que reproduz o preço live;
    //  - senão o limite inferior, mas só se o preço vem da margem (MARGEM). Num preço preso
    //    ao piso ou ao teto do PVPR qualquer margem do intervalo dá o mesmo preço: a margem
    //    de origem é desconhecida (null), nunca um 5 % inventado.
    let marginPct = null;
    let assumed = false;
    if (inferred.range) {
      const [lo, hi] = inferred.range;
      if (assumeMargin != null && assumeMargin >= lo && assumeMargin <= hi && priceAt(assumeMargin) != null && Math.round(priceAt(assumeMargin) * 100) === Math.round(live.price * 100)) {
        marginPct = assumeMargin;
        assumed = true;
      } else if (statusAt(inferred.marginPct) === "MARGEM") {
        marginPct = inferred.marginPct;
      }
    }
    const row = {
      ...base,
      livePrice: live.price,
      cost: now0.cost,
      pvpr: now0.pvpr,
      ruleNow: now0.finalPrice,
      marginPct,
      assumed,
      range: inferred.range,
      ambiguous: inferred.ambiguous,
    };
    const status = inferred.range ? statusAt(marginPct ?? inferred.marginPct) : null;
    row.priceStatus = status;
    row.write = buildLastPriceWrite({
      price: live.price,
      cost: now0.cost,
      pvpr: now0.pvpr,
      marginPct,
      priceStatus: status,
      source: "backfill",
      at: now,
      marginInferred: marginPct != null,
    });
    // Nenhuma margem reproduz o preço live: pode ser preço editado à mão. Fica na lista
    // com o aviso — o Carlos decide se grava ou exclui (--skip).
    let reason = null;
    if (!inferred.range) reason = "NENHUMA margem reproduz o preço live — possível preço manual";
    else if (marginPct == null) reason = "preço preso ao piso/teto do PVPR — margem de origem desconhecida";
    return { ...row, action: "RECORD", reason };
  });
}
