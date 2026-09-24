/**
 * Deteção dos dois placeholders internos de descriptionHtml em coleções Universe —
 * B14 (briefing backend, 24/09/2026). Módulo puro, sem I/O, para poder ser testado
 * (scripts/tests/collection-description-clean.test.js) sem arrastar sessão/Prisma.
 * Consumido por scripts/maintenance/collection-description-clean.js e por
 * prePublishChecks.server.js (SUPPLIER_TOKENS, secção 3) — fonte única dos dois
 * padrões, nenhum escrito em dois sítios.
 *
 * A Shopify guarda descriptionHtml com markup à volta (tipicamente <p>...</p>) e pode
 * devolver o travessão como entidade (&mdash;, &#8212;, &#x2014;) em vez do caráter —
 * a comparação corre sobre o texto sem HTML e com entidades descodificadas, nunca sobre
 * o HTML bruto.
 */

// Texto puro dos dois placeholders — fonte única. PLACEHOLDER_PATTERNS deriva daqui;
// SUPPLIER_TOKENS (prePublishChecks.server.js) importa PLACEHOLDER_SNIPPETS diretamente.
export const PLACEHOLDER_SNIPPETS = [
  { name: "universe", text: "Coleção Universe — produtos com" },
  { name: "auto", text: "Coleção criada automaticamente —" },
];

export const PLACEHOLDER_PATTERNS = PLACEHOLDER_SNIPPETS.map(({ name, text }) => ({
  name,
  re: new RegExp(`^${text}`),
}));

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
