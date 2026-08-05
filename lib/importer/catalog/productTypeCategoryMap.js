/**
 * Tipo de produto do fornecedor → chave da Standard Product Taxonomy da Shopify.
 *
 * PORQUÊ ESTE FICHEIRO
 * O `categoria_principal` da OcioStock não é um eixo de tipo de produto: resolve para
 * franquias e buckets de marketing (Anime & Manga, Disney, Funko, Brands, Clearance).
 * Por isso só 6,2% do catálogo recebia categoria oficial — as chaves aprovadas em
 * taxonomy-map.json > shopifyCategoryIds nunca eram alcançadas.
 *
 * O `product_type_path` (xml_campos_dinamicos), esse, está preenchido em 100% dos
 * produtos e o SEGUNDO segmento é o tipo real ("MODA Y COMPLEMENTOS|CAMISETAS M/C").
 * Mapeando-o subimos a cobertura para ~63% sem inventar categorias novas: todas as
 * chaves abaixo já constavam das 40 revistas manualmente a 2026-08-04.
 *
 * Chaves em maiúsculas e sem acentos na normalização (ver normalizeSegment), para
 * tolerar variações de acentuação do feed.
 */

/** @type {Record<string, string>} chave normalizada do fornecedor → chave de shopifyCategoryIds */
export const PRODUCT_TYPE_SEGMENT_TO_CATEGORY = {
  // Figuras e colecionáveis
  "POP VINYLS": "Figures & Statues",
  "POCKET POP KEYCHAIN": "Figures & Statues",
  FIGURAS: "Action Figures",
  "CABLE GUY": "Figures & Statues",
  REPLICA: "Figures & Statues",
  MUNECAS: "Action Figures",
  PELUCHES: "Plush Toys",
  MAQUETAS: "Model Kit",

  // Moda e acessórios
  "CAMISETAS M/C": "T-Shirt",
  "CAMISETAS M/L": "T-Shirt",
  CAMISETAS: "T-Shirt",
  SUDADERAS: "Hoodie",
  GORRAS: "Cap",
  CALCETINES: "Apparel",
  DISFRACES: "Costume",
  MASCARAS: "Mask",
  BISUTERIA: "Earrings",
  PENDIENTES: "Earrings",
  RELOJES: "Apparel",

  // Sacos e bagagem
  MOCHILAS: "Backpack",
  MALETAS: "Suitcase",
  TROLLEYS: "Suitcase",
  BOLSOS: "Bag",
  BOLSAS: "Bag",
  BANDOLERAS: "Bag",
  "BOLSAS MERIENDA": "Bag",
  NECESERES: "Bag",
  PORTATODOS: "Bag",
  CARTERAS: "Wallet",
  MONEDEROS: "Wallet",

  // Casa
  TAZAS: "Mugs",
  BOTELLAS: "Water Bottle",
  COJINES: "Cushion",
  TOALLAS: "Towel",
  MANTAS: "Blanket",
  LAMPARAS: "Lamp",
  FELPUDOS: "Home & Living",
  HUCHAS: "Money Box",
  PARAGUAS: "Home & Living",
  SACOS: "Home & Living",

  // Papelaria
  "CUADERNOS / BLOC": "Notebook",
  CUADERNOS: "Notebook",
  "SET PAPELERIA": "School Supplies",
  PLUMIERES: "School Supplies",
  BOLIGRAFOS: "School Supplies",
  "PINTAR / COLOREAR": "School Supplies",
  "ACCESORIOS CABELLO": "Apparel",

  // Jogos
  PUZZLES: "Puzzle",
  "JUEGOS MESA": "Board Games",
  "JUEGOS CARTAS": "Trading Card Games",
  JUGUETES: "Toys",
  "COCHES Y CIRCUITOS": "Toys",

  // Diversos
  LLAVEROS: "Gifts",
  POSTERS: "Poster",
  PEGATINAS: "Sticker",
  PINES: "Pin",
  AURICULARES: "Headphones",
  ALFOMBRILLAS: "Mouse Pad",
};

/**
 * Normaliza um segmento do fornecedor: maiúsculas, sem acentos, espaços colapsados.
 * @param {string} raw
 */
export function normalizeSegment(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Chave de shopifyCategoryIds para um productTypePath do fornecedor.
 * Tenta o 2.º segmento (o tipo específico) e depois o 1.º (o genérico).
 * @param {string} productTypePath ex: "MODA Y COMPLEMENTOS|CAMISETAS M/C"
 * @returns {string|undefined}
 */
export function categoryKeyFromProductTypePath(productTypePath) {
  const parts = String(productTypePath || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;

  for (const idx of [1, 0]) {
    const seg = parts[idx];
    if (!seg) continue;
    const key = PRODUCT_TYPE_SEGMENT_TO_CATEGORY[normalizeSegment(seg)];
    if (key) return key;
  }
  return undefined;
}

/**
 * Variante para o caminho de publicação, que lê da BD e não do CSV.
 *
 * `CatalogProduct` não guarda o productTypePath, mas guarda `categorySegments`, que o
 * csvFieldMap constrói como [...segmentos de categoria, ...segmentos do productTypePath]
 * — ou seja, do genérico para o específico. Fica o ÚLTIMO match, que é o mais específico.
 *
 * Validado contra os 30.835 produtos do CSV: concorda com categoryKeyFromProductTypePath
 * em 25.947 de 25.948 casos (a única divergência é a favor desta via). Evitou acrescentar
 * uma coluna productTypePath só para o publish.
 *
 * @param {string[]|undefined} segments
 * @returns {string|undefined}
 */
export function categoryKeyFromSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return undefined;
  let found;
  for (const seg of segments) {
    const key = PRODUCT_TYPE_SEGMENT_TO_CATEGORY[normalizeSegment(seg)];
    if (key) found = key;
  }
  return found;
}
