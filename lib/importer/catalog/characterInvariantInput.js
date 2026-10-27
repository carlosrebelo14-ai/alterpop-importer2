/**
 * characterInvariantInput — monta o estado que checkCharacterInvariants precisa a partir
 * dos nós lidos da Shopify (puro, sem I/O). Tudo passa por GID antes de comparar: a lista
 * alterpop.character e as listas C.products / alterpop.characters são JSON de GIDs.
 *
 * Defeito corrigido (27/10/2026): a query de metaobjects não pedia `id`. O mapa GID → handle
 * ficava vazio, e o verificador dizia 0 produtos com alterpop.character e GIDs inexistentes,
 * com o estado real a ser outro.
 */

export function parseGidList(value) {
  try {
    const v = JSON.parse(value || "[]");
    return Array.isArray(v) ? v.map((g) => String(g).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * @param {Object} input
 * @param {Array<{ id?: string, handle: string, capabilities?: any, universe?: { value: string }, products?: { value: string } }>} input.characterNodes
 * @param {Array<{ id: string, sku: string|null, status: string, vendor?: string|null, franchise?: { value: string }, character?: { value: string } }>} input.productNodes
 * @param {Array<{ name: string, id: string, characters?: { value: string } }>} input.universeCollections
 */
export function buildInvariantInput({ characterNodes = [], productNodes = [], universeCollections = [] }) {
  const handleByGid = new Map(characterNodes.filter((n) => n.id).map((n) => [n.id.trim(), n.handle]));
  const skuByProductGid = new Map(productNodes.filter((p) => p.id).map((p) => [p.id.trim(), p.sku]));
  const universeNameByGid = new Map(universeCollections.map((u) => [u.id.trim(), u.name]));

  const products = productNodes.map((p) => ({
    sku: p.sku || null,
    status: p.status,
    published: true,
    franchise: parseGidListOrStrings(p.franchise?.value)[0] || null,
    vendor: p.vendor || null,
    characters: parseGidList(p.character?.value).map((g) => handleByGid.get(g)).filter(Boolean),
  }));

  const characters = new Map(
    characterNodes.map((n) => [
      n.handle,
      {
        status: n.capabilities?.publishable?.status || "DRAFT",
        universes: parseGidList(n.universe?.value).map((g) => universeNameByGid.get(g) || g),
        products: parseGidList(n.products?.value).map((g) => skuByProductGid.get(g)).filter(Boolean),
      },
    ]),
  );

  const universeCharacters = new Map(
    universeCollections.map((u) => [u.name, parseGidList(u.characters?.value).map((g) => handleByGid.get(g) || g)]),
  );

  return { products, characters, universeCharacters };
}

/** franchise é list.single_line_text_field: strings, não GIDs. */
function parseGidListOrStrings(value) {
  try {
    const v = JSON.parse(value || "[]");
    return Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
