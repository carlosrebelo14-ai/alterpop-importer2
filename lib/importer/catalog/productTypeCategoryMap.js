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
  MUNECAS: "Dolls",
  PELUCHES: "Plush Toys",
  MAQUETAS: "Model Kit",

  // Moda e acessórios
  "CAMISETAS M/C": "T-Shirt",
  "CAMISETAS M/L": "T-Shirt",
  CAMISETAS: "T-Shirt",
  SUDADERAS: "Hoodie",
  "PIJAMAS M/L": "Pyjamas",
  "PIJAMAS M/C": "Pyjamas",
  PIJAMAS: "Pyjamas",
  GORRAS: "Cap",
  CALCETINES: "Apparel",
  DISFRACES: "Costume",
  "GAFAS SOL": "Sunglasses",
  MASCARAS: "Mask",
  BISUTERIA: "Jewellery",
  PENDIENTES: "Earrings",
  RELOJES: "Apparel",

  // Sacos e bagagem
  MOCHILAS: "Backpack",
  // lb-12-9 ("Conjuntos de malas de viagem") descrevia conjuntos, não malas
  // individuais — ambos são trolleys de viagem, logo Malas de porão.
  MALETAS: "Checked Luggage",
  TROLLEYS: "Checked Luggage",
  // Malas de moda (o fornecedor traduz shoulder bag / handbag / tote / crossbody),
  // não bagagem: lb-13 ("Sacos", Bagagem e malas) classificava-as mal.
  BOLSOS: "Handbag",
  BOLSAS: "Handbag",
  BANDOLERAS: "Handbag",
  "BOLSAS MERIENDA": "Bag",
  NECESERES: "Toiletry Bag",
  // Estojo escolar: a taxonomia Shopify não tem categoria própria (procurado em
  // 2026-08-07 por estojo/estojos/estojo escolar/material escolar) — fica no pai.
  PORTATODOS: "School Supplies",
  CARTERAS: "Wallet",
  MONEDEROS: "Coin Purse",

  // Casa
  TAZAS: "Mugs",
  BOTELLAS: "Water Bottle",
  COJINES: "Cushion",
  TOALLAS: "Towel",
  // Blanket já aponta para hg-15-1-4 ("Cobertores"), o nó específico — confirmado
  // a 2026-08-07, não é o genérico hg-15-1.
  MANTAS: "Blanket",
  "FUNDAS / EDREDONES": "Duvet Cover",
  "JUEGOS DE CAMA": "Bedding",
  LAMPARAS: "Lamp",
  FELPUDOS: "Doormat",
  HUCHAS: "Money Box",
  PARAGUAS: "Umbrella",
  // Sacos-mochila de cordas — o fornecedor traduz "gym bag" / "sack backpack".
  SACOS: "Backpack",

  // Papelaria
  "CUADERNOS / BLOC": "Notebook",
  CUADERNOS: "Notebook",
  "SET PAPELERIA": "School Supplies",
  PLUMIERES: "School Supplies",
  BOLIGRAFOS: "School Supplies",
  "PINTAR / COLOREAR": "School Supplies",
  "ACCESORIOS CABELLO": "Hair Accessories",

  // Jogos
  PUZZLES: "Puzzle",
  "JUEGOS MESA": "Board Games",
  "JUEGOS CARTAS": "Trading Card Games",
  JUGUETES: "Toys",
  "COCHES Y CIRCUITOS": "Toy Cars",

  // Diversos
  LLAVEROS: "Keychain",
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
