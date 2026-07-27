const STOP_WORDS = new Set([
  "the",
  "of",
  "and",
  "de",
  "da",
  "do",
  "dos",
  "das",
  "el",
  "la",
  "los",
  "las",
]);

export function norm(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * @param {string} text
 */
export function significantTokens(text) {
  return norm(text)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Match by substring or by all significant tokens (avoids "ring" in "gathering").
 * @param {string} haystack
 * @param {string} needle
 */
export function textMatchesQuery(haystack, needle) {
  const h = norm(haystack);
  const n = norm(needle);
  if (!h || !n) return false;
  if (h.includes(n) || n.includes(h)) return true;
  const tokens = significantTokens(needle);
  if (tokens.length >= 2) {
    return tokens.every((t) => h.includes(t));
  }
  return false;
}

/**
 * Franchise refs that are really product blurbs should not become licence facets.
 * @param {string} ref
 */
export function isPlausibleFranchiseRef(ref) {
  const s = String(ref || "").trim();
  if (s.length < 2 || s.length > 56) return false;
  if (/\d{2,}\s*(cm|mm|pzs|gramos|ml)/i.test(s)) return false;
  if (
    /figura vinilo|figura pop|camiseta|puzzle|sudadera|pack de|capacidad|ceramica|tamaño|inoxidable|incluye \d/i.test(
      s
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Prefer clean IP names over noisy franchise strings.
 * @param {string} ref
 */
export function franchiseRefScore(ref) {
  const s = String(ref || "").trim();
  if (!isPlausibleFranchiseRef(ref)) return -1;
  let score = 0;
  if (s.length <= 32) score += 8;
  if (/^[A-Z][^.]{2,40}\.?$/i.test(s)) score += 12;
  if (/\|/.test(s)) score -= 6;
  return score;
}
