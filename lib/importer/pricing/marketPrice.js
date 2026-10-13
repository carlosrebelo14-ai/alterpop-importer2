/**
 * Observação manual de preço de mercado (Decisão 31). Módulo puro: validação e leitura.
 *
 * O preço observado (Worten, Fnac…) tem IVA; o preço Alterpop não tem. Por isso a app NÃO
 * calcula diferença entre os dois: mostra o observado com a etiqueta "com IVA" ao lado do
 * preço Alterpop. Sem recolha automática, sem validade, sem bloqueios.
 */

/** Lojas de referência sugeridas na UI; o campo aceita qualquer nome (1 a 60 caracteres). */
export const MARKET_STORE_SUGGESTIONS = Object.freeze(["Worten", "Fnac"]);

export const MAX_STORE_LENGTH = 60;
export const MAX_MARKET_PRICE_EUR = 100000;

export class MarketPriceError extends Error {
  constructor(message) {
    super(message);
    this.name = "MarketPriceError";
  }
}

/**
 * Valida o corpo de POST /api/market-prices/manual.
 * @param {unknown} body { sku, price (euros, até 2 casas), store, observedAt? (ISO; omissão = agora) }
 * @param {Date} [now]
 * @returns {{ sku: string, priceCents: number, store: string, observedAt: Date }}
 */
export function parseMarketObservation(body, now = new Date()) {
  const b = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  const sku = String(b.sku ?? "").trim();
  if (!sku) throw new MarketPriceError("SKU em falta");

  const rawPrice = typeof b.price === "string" ? b.price.trim().replace(",", ".") : b.price;
  const price = Number(rawPrice);
  if (rawPrice === "" || rawPrice == null || !Number.isFinite(price) || price <= 0 || price > MAX_MARKET_PRICE_EUR) {
    throw new MarketPriceError(`Preço inválido (${JSON.stringify(b.price)}) — usa um valor em euros maior que 0`);
  }
  const priceCents = Math.round(price * 100);
  if (Math.abs(price * 100 - priceCents) > 1e-6) {
    throw new MarketPriceError(`Preço inválido (${price}) — no máximo 2 casas decimais`);
  }

  const store = String(b.store ?? "").trim();
  if (!store) throw new MarketPriceError("Loja em falta (ex.: Worten, Fnac)");
  if (store.length > MAX_STORE_LENGTH) throw new MarketPriceError(`Loja demasiado longa (máx. ${MAX_STORE_LENGTH} caracteres)`);

  let observedAt = now;
  if (b.observedAt != null && b.observedAt !== "") {
    observedAt = new Date(String(b.observedAt));
    if (Number.isNaN(observedAt.getTime())) throw new MarketPriceError(`Data inválida (${JSON.stringify(b.observedAt)})`);
    // Um dia de folga para fusos horários; mais do que isso é data futura.
    if (observedAt.getTime() > now.getTime() + 24 * 60 * 60 * 1000) throw new MarketPriceError("A data da observação não pode ser futura");
  }
  return { sku, priceCents, store, observedAt };
}

/**
 * Forma exposta no painel e em /api/products: SEM qualquer campo de diferença.
 * @param {{ priceCents: number, store: string, observedAt: Date|string }} row
 */
export function marketView(row) {
  return {
    priceCents: row.priceCents,
    price: row.priceCents / 100,
    store: row.store,
    observedAt: row.observedAt instanceof Date ? row.observedAt.toISOString() : String(row.observedAt),
    vatIncluded: true,
  };
}

/**
 * A observação mais recente (por data observada; desempate pelo último registo) de cada SKU.
 * @param {Array<{ sku: string, priceCents: number, store: string, observedAt: Date|string, createdAt?: Date|string }>} rows
 * @returns {Map<string, ReturnType<typeof marketView>>}
 */
export function latestObservationBySku(rows) {
  const best = new Map();
  const ts = (v) => (v == null ? 0 : new Date(v).getTime());
  for (const r of rows) {
    const cur = best.get(r.sku);
    if (!cur || ts(r.observedAt) > ts(cur.observedAt) || (ts(r.observedAt) === ts(cur.observedAt) && ts(r.createdAt) >= ts(cur.createdAt))) {
      best.set(r.sku, r);
    }
  }
  return new Map([...best].map(([sku, r]) => [sku, marketView(r)]));
}
