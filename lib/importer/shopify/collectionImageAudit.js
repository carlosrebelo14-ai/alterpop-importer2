/**
 * Deteção de tiles não quadradas em collection.image — B14 (briefing backend,
 * 24/09/2026), secção 8. Módulo puro, sem I/O, para poder ser testado
 * (scripts/tests/collection-image-audit.test.js) sem arrastar sessão/Shopify. Consumido
 * só por scripts/maintenance/collection-image-audit.js.
 *
 * Caso real: regressão Star Wars (18/09/2026) — collection.image não quadrada, logo
 * esticado nas tiles do Explore Universes / mega-menu.
 */

/**
 * Extrai os dados de auditoria de um nó de coleção (query collections { image, hero_image
 * metafield }) e marca tiles não quadradas. Uma imagem sem width/height (upload recente,
 * a Shopify às vezes ainda não devolveu as dimensões) não é marcada — falta de dado não
 * é o mesmo que defeito.
 * @param {{ handle: string, title: string, templateSuffix: string|null, image: {url:string,width:number|null,height:number|null,altText:string|null}|null, heroImage: {reference: {image: object}|null}|null }} node
 */
export function auditCollectionImages(node) {
  const image = node.image
    ? { url: node.image.url, width: node.image.width, height: node.image.height, altText: node.image.altText || null }
    : null;
  const heroImg = node.heroImage?.reference?.image;
  const heroImage = heroImg
    ? { url: heroImg.url, width: heroImg.width, height: heroImg.height, altText: heroImg.altText || null }
    : null;

  const nonSquare =
    !!image && Number.isFinite(image.width) && Number.isFinite(image.height) && image.width !== image.height;

  return {
    handle: node.handle,
    title: node.title,
    templateSuffix: node.templateSuffix,
    image,
    heroImage,
    nonSquare,
  };
}
