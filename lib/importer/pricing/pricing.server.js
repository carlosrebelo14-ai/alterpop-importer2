/**
 * Preço de venda — briefing "Preço com margem e teto de mercado" (07/10/2026), que
 * substitui o de "margem e arredondamento" do mesmo dia (base era o PVPR — errado).
 *
 *   preço = margem sobre o custo, arredondada para cima
 *           nunca acima do PVPR
 *           nunca abaixo do custo + MIN_MARGIN
 *
 * O ÚNICO caminho de preço da app: painel (curadoria, staging, export) e publishers
 * importam daqui.
 *
 * - Custo: round(precio_distribuidores × 1,21) — CatalogProduct.distributorPrice com o
 *   IVA espanhol que o carrinho OcioStock cobra (confirmado: 9,99 → 12,09).
 * - PVPR: precio_bruto (CatalogProduct.grossPrice), já com IVA — teto, nunca custo.
 * - Margem: global (settings.priceMarginPct), sobre o custo, 5 a 100 %, inicial 40 %.
 * - Finais: ,50 e ,90 abaixo de 100 €, só ,90 a partir de 100 €. Margem arredonda para
 *   cima (roundUp); o teto arredonda para baixo (roundDown), para nunca passar o PVPR.
 * - Contas em cêntimos inteiros. IVA da venda fica fora (decisão do briefing).
 *
 * Estado de cada preço (selos no painel — avisam, nunca bloqueiam):
 *   MARGEM      margem pedida cabe abaixo do PVPR
 *   TETO        margem pedida passava o PVPR — preço = PVPR arredondado para baixo
 *   ACIMA_PVPR  nem a margem mínima cabe abaixo do PVPR — preço = custo + MIN_MARGIN
 *   SEM_PVPR    feed sem precio_bruto — margem pedida, sem teto
 *
 * Nada falha em silêncio: sem precio_distribuidores lança PricingError. Quem precisa de
 * mostrar o erro numa linha (painel) usa tryPriceProduct, que o devolve em vez de lançar.
 *
 * Testado em scripts/tests/pricing.test.js.
 */

export const DEFAULT_MARGIN_PCT = 40;
export const MIN_MARGIN_PCT = 5;
export const MAX_MARGIN_PCT = 100;
/** Piso: o preço nunca fica abaixo do custo + 10 %, mesmo que isso passe o PVPR. */
export const MIN_MARGIN = 10;
/** IVA espanhol cobrado pela OcioStock sobre precio_distribuidores, em %. */
export const SUPPLIER_VAT_PCT = 21;

export const PRICE_STATUS = Object.freeze({
  MARGEM: "MARGEM",
  TETO: "TETO",
  ACIMA_PVPR: "ACIMA_PVPR",
  SEM_PVPR: "SEM_PVPR",
});

export class PricingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PricingError";
  }
}

function assertCents(c, fn) {
  if (!Number.isInteger(c) || c < 0) throw new PricingError(`${fn}: cêntimos inválidos (${c})`);
}

/**
 * Arredonda para cima até ao próximo final permitido.
 * @param {number} c cêntimos (inteiro ≥ 0)
 * @returns {number} cêntimos
 */
export function roundUp(c) {
  assertCents(c, "roundUp");
  const e = Math.floor(c / 100) * 100;
  const r = c % 100;
  let p = r <= 50 ? e + 50 : r <= 90 ? e + 90 : e + 150;
  if (p >= 10000) p = r <= 90 ? e + 90 : e + 190;
  return p;
}

/**
 * Arredonda para baixo até ao final permitido anterior (teto do PVPR).
 * @param {number} c cêntimos (inteiro ≥ 0)
 * @returns {number} cêntimos (pode ser negativo para c < 50 — o piso ganha sempre)
 */
export function roundDown(c) {
  assertCents(c, "roundDown");
  const e = Math.floor(c / 100) * 100;
  const r = c % 100;
  if (r >= 90) return e + 90;
  if (r >= 50 && e + 50 < 10000) return e + 50;
  return e - 10;
}

/**
 * @param {number} marginPct
 * @returns {number}
 */
export function assertMarginPct(marginPct) {
  const m = Number(marginPct);
  if (!Number.isFinite(m) || m < MIN_MARGIN_PCT || m > MAX_MARGIN_PCT) {
    throw new PricingError(`Margem inválida (${marginPct}) — tem de estar entre ${MIN_MARGIN_PCT} e ${MAX_MARGIN_PCT} %`);
  }
  return m;
}

/**
 * @param {number} distCents precio_distribuidores em cêntimos (inteiro > 0), sem IVA
 * @param {number|null|undefined} pvprCents precio_bruto em cêntimos, ou vazio
 * @param {number} marginPct 5 a 100
 * @returns {{ price: number, cost: number, status: keyof typeof PRICE_STATUS }} cêntimos
 */
export function finalPrice(distCents, pvprCents, marginPct) {
  if (!Number.isInteger(distCents) || distCents <= 0) {
    throw new PricingError(`precio_distribuidores inválido (${distCents} cêntimos)`);
  }
  const m = assertMarginPct(marginPct);
  // × 1,21 em inteiros (× 121 / 100): evita 999 × 1.21 = 1208.7900000000002.
  const cost = Math.round((distCents * (100 + SUPPLIER_VAT_PCT)) / 100);
  const withM = (pct) => roundUp(Math.ceil((cost * (100 + pct)) / 100));
  const target = withM(m);
  const floor = withM(MIN_MARGIN);

  if (!pvprCents) return { price: Math.max(floor, target), cost, status: PRICE_STATUS.SEM_PVPR };
  if (!Number.isInteger(pvprCents) || pvprCents < 0) {
    throw new PricingError(`precio_bruto inválido (${pvprCents} cêntimos)`);
  }

  const cap = roundDown(pvprCents);
  const price = Math.max(floor, Math.min(target, cap));
  const status =
    target <= cap ? PRICE_STATUS.MARGEM : cap >= floor ? PRICE_STATUS.TETO : PRICE_STATUS.ACIMA_PVPR;
  return { price, cost, status };
}

/**
 * Margem global das definições da loja. Sem valor gravado → DEFAULT_MARGIN_PCT; valor
 * gravado fora do intervalo → lança (nunca cai em silêncio para o default).
 * @param {{ priceMarginPct?: number|string|null }} [settings]
 */
export function resolveMarginPct(settings) {
  const raw = settings?.priceMarginPct;
  if (raw == null || raw === "") return DEFAULT_MARGIN_PCT;
  return assertMarginPct(raw);
}

/** euros (float do feed) → cêntimos inteiros, ou null se vazio/≤ 0 */
function toCents(euros) {
  const n = Number(euros);
  if (euros == null || euros === "" || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/**
 * Preço de um produto a partir das colunas do catálogo (euros).
 * @param {number|null|undefined} distributorPrice precio_distribuidores, sem IVA
 * @param {number|null|undefined} grossPrice precio_bruto (PVPR com IVA)
 * @param {number} marginPct
 * @returns {{ finalPrice: number, cost: number, profit: number, pvpr: number|null,
 *   priceStatus: string, finalCents: number, costCents: number }}
 */
export function priceProduct(distributorPrice, grossPrice, marginPct) {
  const distCents = toCents(distributorPrice);
  if (distCents == null) {
    throw new PricingError("Sem precio_distribuidores (custo) — preço não calculado");
  }
  const pvprCents = toCents(grossPrice);
  const { price, cost, status } = finalPrice(distCents, pvprCents, marginPct);
  return {
    finalPrice: price / 100,
    cost: cost / 100,
    profit: (price - cost) / 100,
    pvpr: pvprCents != null ? pvprCents / 100 : null,
    priceStatus: status,
    finalCents: price,
    costCents: cost,
  };
}

/**
 * Igual a priceProduct, mas devolve o erro em vez de lançar — para mostrar por linha.
 * @param {number|null|undefined} distributorPrice
 * @param {number|null|undefined} grossPrice
 * @param {number} marginPct
 * @returns {{ finalPrice: number|null, cost: number|null, profit: number|null,
 *   pvpr: number|null, priceStatus: string|null, priceError: string|null }}
 */
export function tryPriceProduct(distributorPrice, grossPrice, marginPct) {
  try {
    const { finalPrice: price, cost, profit, pvpr, priceStatus } = priceProduct(distributorPrice, grossPrice, marginPct);
    return { finalPrice: price, cost, profit, pvpr, priceStatus, priceError: null };
  } catch (err) {
    return {
      finalPrice: null,
      cost: null,
      profit: null,
      pvpr: toCents(grossPrice) != null ? toCents(grossPrice) / 100 : null,
      priceStatus: null,
      priceError: err?.message || String(err),
    };
  }
}
