/**
 * characterInvariants — I1 a I6 sobre o estado já lido (PR 4, decisão de 27/10/2026).
 * Puro, sem I/O. Quem chama lê a loja e o Prisma e passa aqui os dados.
 *
 * I1  Para cada Character ACTIVE, C.products = produtos cujo alterpop.character contém C.   Vermelho
 * I2  C ACTIVE ⇔ ≥1 produto ACTIVE publicado na Online Store. Limiar 1. `qa-dead-ref` fora.  Vermelho
 * I3  C ACTIVE e U ∈ C.universe ⇒ C ∈ U.alterpop.characters.                              Vermelho
 * I4  C ∈ U.alterpop.characters ⇒ C ACTIVE.                                               Vermelho
 * I5  Produto ACTIVE ⇒ franchise não vazia.                                                Vermelho
 * I6  Vendor no mapa canónico.                                                             Amarelo
 */

export const EXCLUDED_HANDLES = new Set(["qa-dead-ref"]);

const sameSet = (a, b) => {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

/**
 * @param {Object} input
 * @param {Map<string, { status: 'ACTIVE'|'DRAFT', universes: string[], products: string[] }>} input.characters
 *   handle -> metaobject (products = lista de SKUs em C.products)
 * @param {Array<{ sku: string, status: 'ACTIVE'|'DRAFT', published: boolean, franchise: string|null, vendor: string|null, characters: string[] }>} input.products
 *   characters = handles em alterpop.character do produto
 * @param {Map<string, string[]>} input.universeCharacters  universo -> handles em alterpop.characters
 * @param {Set<string>} input.canonicalVendors
 * @returns {{ red: Array<{ id: string, handle?: string, sku?: string, message: string }>, yellow: Array<{ id: string, sku?: string, message: string }> }}
 */
export function checkCharacterInvariants({ characters, products, universeCharacters, canonicalVendors }) {
  const red = [];
  const yellow = [];
  const productsByHandle = new Map();
  for (const p of products) {
    for (const h of p.characters || []) {
      if (!productsByHandle.has(h)) productsByHandle.set(h, new Set());
      productsByHandle.get(h).add(p.sku);
    }
  }

  for (const [handle, c] of characters) {
    if (EXCLUDED_HANDLES.has(handle)) continue;

    // I1 — só para ACTIVE. DRAFT mantém a última composição (secção 6 do arranque).
    if (c.status === "ACTIVE") {
      const fromProducts = productsByHandle.get(handle) || new Set();
      const inList = new Set(c.products || []);
      if (!sameSet(inList, fromProducts)) {
        red.push({ id: "I1", handle, message: `C.products (${inList.size}) ≠ produtos com alterpop.character (${fromProducts.size})` });
      }
    }

    // I2 — limiar 1, produto ACTIVE publicado.
    const liveProducts = products.filter((p) => p.status === "ACTIVE" && p.published && (p.characters || []).includes(handle));
    const shouldBeActive = liveProducts.length >= 1;
    if (shouldBeActive && c.status !== "ACTIVE") {
      red.push({ id: "I2", handle, message: `${liveProducts.length} produto(s) ACTIVE publicado(s) e C está ${c.status}` });
    }
    if (!shouldBeActive && c.status === "ACTIVE") {
      red.push({ id: "I2", handle, message: "C ACTIVE sem produto ACTIVE publicado" });
    }

    // I3 — ACTIVE ⇒ aparece em alterpop.characters de cada universo.
    if (c.status === "ACTIVE") {
      for (const u of c.universes || []) {
        const list = universeCharacters.get(u) || [];
        if (!list.includes(handle)) red.push({ id: "I3", handle, message: `ausente de alterpop.characters de ${u}` });
      }
    }
  }

  // I4 — o que está em alterpop.characters tem de ser ACTIVE.
  for (const [universo, handles] of universeCharacters) {
    for (const handle of handles) {
      if (EXCLUDED_HANDLES.has(handle)) continue;
      const c = characters.get(handle);
      if (!c || c.status !== "ACTIVE") {
        red.push({ id: "I4", handle, message: `em alterpop.characters de ${universo} mas ${c ? c.status : "inexistente"}` });
      }
    }
  }

  for (const p of products) {
    // I5 — produto ACTIVE sem franchise.
    if (p.status === "ACTIVE" && !(p.franchise && String(p.franchise).trim())) {
      red.push({ id: "I5", sku: p.sku, message: "produto ACTIVE sem franchise" });
    }
    // I6 — vendor fora do mapa canónico. Amarelo, vai para o relatório.
    if (p.vendor && canonicalVendors && !canonicalVendors.has(p.vendor)) {
      yellow.push({ id: "I6", sku: p.sku, message: `vendor "${p.vendor}" fora do mapa canónico` });
    }
  }

  return { red, yellow };
}
