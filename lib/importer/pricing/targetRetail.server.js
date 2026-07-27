const MARGIN = 0.4;

/**
 * Preço de venda alvo: custo / (1 - margem).
 * @param {number|null|undefined} netPrice
 * @returns {number|null}
 */
export function computeTargetRetailPrice(netPrice) {
  if (netPrice == null || !Number.isFinite(netPrice) || netPrice <= 0) return null;
  return netPrice / (1 - MARGIN);
}

/**
 * @param {number|null|undefined} value
 * @param {string} [locale]
 */
export function formatEur(value, locale = "pt-PT") {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
  }).format(value);
}
