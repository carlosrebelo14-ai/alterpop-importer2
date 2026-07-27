/** Utilitário seguro para cliente — sem fs/taxonomia servidor. */

/** @param {number|null|undefined} value */
export function formatEur(value, locale = "pt-PT") {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
  }).format(value);
}

/** @param {string} key */
export function translateCategoryLabel(key) {
  if (!key) return "—";
  if (key.startsWith("[UNTRANSLATED]")) {
    return key.replace(/^\[UNTRANSLATED\]\s*/i, "").trim() || "—";
  }
  return key;
}
