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
  // Um array passa pelo mesmo caminho que a string. O servidor só recebe string, por isso a lista tem de ser igual.
  if (Array.isArray(imageUrl)) return resolveAllProductImages(imageUrl.join("\n"));
  const str = String(imageUrl).trim();
  if (!str) return [];
  const valid = [];
  for (const parte of str.split(SEPARADORES)) {
    const limpo = parte.trim().replace(/^["']|["']$/g, "");
    // Protocolo relativo (//host/...) vale como https, como no painel (normalizeImageUrl do importador).
    // Sem isto a rota recebia outra lista e os índices deixavam de bater com as miniaturas.
    const clean = limpo.startsWith("//") ? "https:" + limpo : limpo;
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
 * Versão curta de um URL de origem: FNV-1a de 32 bits, em 8 caracteres hexadecimais.
 *
 * O browser guarda a miniatura durante dias. Se o fornecedor trocar a foto, o URL da app seria o mesmo e o
 * browser mostraria a antiga. Com a versão no ?v=, uma foto nova dá um URL novo.
 *
 * Não se usa crypto: o resultado tem de ser igual no browser e no Node, e só serve para distinguir URLs.
 * Não é segurança, e não esconde o URL de origem.
 * @param {string} url
 * @returns {string}
 */
export function versaoDaUrl(url) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * URL relativo da imagem `indice` do produto `sku`. A rota lê o imageUrl do catálogo por sku e indice.
 * O ?v= é só para o cache do browser. A rota ignora a query.
 *
 * urlOrigem é o URL que resolveAllProductImages dá para esse índice. Sem ele, a foto trocada no
 * fornecedor continuava em cache com o URL antigo. Por isso não há chamada sem ele.
 * @param {string} sku
 * @param {number} indice
 * @param {string} urlOrigem
 * @returns {string}
 * @throws {TypeError} se urlOrigem não for uma string não vazia
 */
export function urlDaImagemDoCatalogo(sku, indice, urlOrigem) {
  if (typeof urlOrigem !== "string" || urlOrigem.length === 0) {
    throw new TypeError("urlOrigem tem de ser uma string não vazia");
  }
  return `${PREFIXO_IMAGEM_CATALOGO}/${encodeURIComponent(String(sku))}/${indice}?v=${versaoDaUrl(urlOrigem)}`;
}
