/**
 * Lista de URLs de imagem de um produto do catálogo, na ordem em que o painel as mostra.
 *
 * Partilhada pelo componente da miniatura (app/components/CatalogProductThumbnail.jsx) e pela rota que serve a
 * imagem por índice (app/routes/api.catalog-image.$sku.$i.jsx). Se as duas listas diferirem, o índice aponta
 * para imagens diferentes. Por isso a regra vive num só sítio, e não tem React nem Prisma.
 */

const SEPARADORES = /[,;|\n\r]+/;
const URL_VALIDO = /^https?:\/\/[^\s]+/i;

/**
 * Divide o campo, tira espaços e aspas, e fica só com os URL http(s). Sem repetidos, na ordem de chegada.
 * @param {string | string[] | null | undefined} imageUrl
 * @returns {string[]}
 */
export function resolveAllProductImages(imageUrl) {
  if (!imageUrl) return [];
  if (Array.isArray(imageUrl)) return imageUrl.filter(Boolean);
  const str = String(imageUrl).trim();
  if (!str) return [];
  const valid = [];
  for (const parte of str.split(SEPARADORES)) {
    const clean = parte.trim().replace(/^["']|["']$/g, "");
    if (clean && URL_VALIDO.test(clean)) valid.push(clean);
  }
  return Array.from(new Set(valid));
}

/**
 * @param {string | null | undefined} imageUrl
 * @returns {string | null}
 */
export function resolveProductImageSource(imageUrl) {
  return resolveAllProductImages(imageUrl)[0] || null;
}

/** Prefixo da rota que serve a imagem do catálogo pela app (sem URL do fornecedor no cliente). */
export const PREFIXO_IMAGEM_CATALOGO = "/api/catalog-image";

/**
 * URL relativo da imagem `indice` do produto `sku`. A rota lê o imageUrl do catálogo por sku e indice.
 * @param {string} sku
 * @param {number} indice
 * @returns {string}
 */
export function urlDaImagemDoCatalogo(sku, indice) {
  return `${PREFIXO_IMAGEM_CATALOGO}/${encodeURIComponent(String(sku))}/${indice}`;
}
