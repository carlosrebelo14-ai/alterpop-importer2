/**
 * Deteção dos dois placeholders internos de descriptionHtml em coleções Universe —
 * B14 (briefing backend, 24/09/2026). Módulo puro, sem I/O, para poder ser testado
 * (scripts/tests/collection-description-clean.test.js) sem arrastar sessão/Prisma.
 * Consumido só por scripts/maintenance/collection-description-clean.js.
 *
 * A Shopify guarda descriptionHtml com markup à volta (tipicamente <p>...</p>) e pode
 * devolver o travessão como entidade (&mdash;, &#8212;, &#x2014;) em vez do caráter —
 * a comparação corre sobre o texto sem HTML e com entidades descodificadas, nunca sobre
 * o HTML bruto.
 */

export const PLACEHOLDER_PATTERNS = [
  { name: "universe", re: /^Coleção Universe — produtos com/ },
  { name: "auto", re: /^Coleção criada automaticamente —/ },
];

const HTML_ENTITIES = {
  "&mdash;": "—",
  "&ndash;": "–",
  "&amp;": "&",
  "&nbsp;": " ",
};

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-z]+;/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity);
}

/** Remove tags HTML, descodifica entidades e colapsa espaço em branco — mesmo texto que
 *  o cliente veria. */
export function stripHtml(html) {
  return decodeHtmlEntities(
    String(html || "").replace(/<[^>]*>/g, "")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** @returns {{name: string} | null} o padrão que bateu, ou null */
export function matchPlaceholder(html) {
  const text = stripHtml(html);
  return PLACEHOLDER_PATTERNS.find((p) => p.re.test(text)) || null;
}
