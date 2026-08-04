/**
 * Decide se o título inglês que a OcioStock já envia (coluna `xml_info_otros_idiomas`,
 * ver parseSupplierTitleByLang) é utilizável como fonte primária, ou se o produto tem
 * de cair no pipeline de tradução (glossário + API).
 *
 * Contexto (2026-08-04): o feed traz título EN em 99,8% das linhas e o importer nunca o
 * usou. Medido contra o CSV real, usá-lo como fonte primária corta ~99% das idas à API e
 * elimina de raiz a classe de erros que andávamos a corrigir à mão (sable→sailor,
 * Frieren→Fry, Rey→King, Solo→Alone, cascatas Game/Board...). O fornecedor tinha todos
 * esses casos corretos desde sempre.
 *
 * O detetor é DELIBERADAMENTE conservador só onde tem de ser: rejeitar um título bom
 * custa uma ida ao pipeline antigo (barato, é o comportamento de hoje), mas aceitar um
 * título espanhol publica espanhol na loja (caro). Ainda assim não pode ser cego —
 * uma versão anterior desta heurística rejeitava "Los Angeles Football Club" (batia em
 * "los") e "Seleccion Española" (por ter acento), que são casos legítimos.
 */

/**
 * Substantivos-cabeça espanhóis de produto. Derivados empiricamente da primeira palavra
 * dos 30.835 títulos ES do catálogo. Se um destes aparece num título supostamente inglês,
 * o fornecedor não traduziu — repetiu o espanhol.
 *
 * Excluídos de propósito por serem internacionais e aparecerem legitimamente em inglês:
 * set, puzzle, blister, trolley, poster, cable, mini, pack, display, kit.
 *
 * Também excluídos por serem homógrafos inglês/espanhol — auditoria dos 39 casos
 * rejeitados por este critério a 2026-08-04 mostrou que eram os únicos falsos positivos:
 *   mantel  — EN lareira / ES toalha de mesa ("Hogwarts Express mantel plaque")
 *   collar  — EN gola / ES colar ("hat + collar + gloves set")
 * Se um título espanhol com estes termos aparecer, cai no critério `untranslated` ou
 * noutro substantivo da lista; nenhum caso do catálogo depende só deles.
 */
const SPANISH_PRODUCT_NOUNS = [
  "figura", "figuras", "mochila", "mochilas", "camiseta", "camisetas", "peluche", "peluches",
  "portatodo", "llavero", "llaveros", "taza", "tazas", "maleta", "maletas", "maletin",
  "bolsa", "bolsas", "bolso", "bolsos", "neceser", "cuaderno", "cuadernos", "muñeca",
  "muñeco", "muñecas", "muñecos", "reloj", "relojes", "botella", "botellas", "boligrafo",
  "boligrafos", "toalla", "toallas", "paraguas", "coche", "coches", "cojin", "cojines",
  "plumier", "cartera", "carteras", "colgante", "colgantes", "saco", "auriculares",
  "deportivas", "lampara", "lamparas", "maqueta", "maquetas", "felpudo", "pendientes",
  "pulsera", "pulseras", "gafas", "sudadera", "sudaderas", "cantimplora", "cantimploras",
  "diario", "riñonera", "estuche", "estuches", "alfombra", "manta", "mantas", "delantal",
  "vaso", "vasos", "jarra", "jarras", "hucha", "huchas", "juguete", "juguetes", "zapatillas",
  "calcetines", "gorro", "gorra", "bufanda", "guantes", "pijama", "chaqueta", "vestido",
  "disfraz", "espejo", "cepillo", "peine", "pegatinas", "libreta", "agenda", "marcapaginas",
  "posavasos", "abrelatas", "sacapuntas", "servilletas", "cubiertos", "plato",
  "cuchara", "tenedor", "bandeja", "cesta", "caja", "cajas", "linterna", "despertador",
  "cargador", "altavoz", "raton", "teclado", "funda", "fundas", "correa", "cinturon",
  "bañador", "sombrilla", "flotador", "pistola", "espada", "escudo", "casco", "corona",
  "diadema", "anillo", "broche", "insignia", "chapa", "iman", "imanes",
];

/** Fronteira Unicode-aware — \b do JS trata acentos como fronteira e daria falsos positivos. */
const SPANISH_NOUN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${SPANISH_PRODUCT_NOUNS.join("|")})(?![\\p{L}\\p{N}_])`,
  "iu"
);

/** Pontuação exclusiva do espanhol — se está presente, o texto não foi traduzido. */
const SPANISH_PUNCTUATION_RE = /[¿¡]/;

/**
 * O campo do fornecedor às vezes vem com lixo em vez de título. Encontrado a 2026-08-04
 * ao auditar o diff completo: o SKU da "Piramide Balanceante Sensorial Fisher-Price"
 * trazia `13.99` — o preço — no lugar do título em inglês. Publicaria um produto
 * chamado "13.99" na loja.
 */
const NUMERIC_ONLY_RE = /^[\d\s.,\-–—/€$£%]+$/;

/** @param {string} s */
function normalizeForCompare(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * @typedef {object} SupplierTitleVerdict
 * @property {boolean} usable
 * @property {"ok"|"empty"|"numeric"|"untranslated"|"spanish-punctuation"|"spanish-noun"} reason
 * @property {string} [match] termo que despoletou a rejeição (diagnóstico)
 */

/**
 * @param {string} supplierEn título vindo do fornecedor
 * @param {string} originalEs título espanhol da mesma linha
 * @returns {SupplierTitleVerdict}
 */
export function evaluateSupplierTitle(supplierEn, originalEs) {
  const en = String(supplierEn || "").trim();
  if (!en) return { usable: false, reason: "empty" };

  // Lixo numérico (preços, códigos) antes de qualquer outra verificação: um título
  // destes passaria em todos os critérios linguísticos por não ter palavra nenhuma.
  if (NUMERIC_ONLY_RE.test(en)) return { usable: false, reason: "numeric", match: en };

  // Sem uma única letra não é um título utilizável, seja o que for que lá esteja.
  if (!/\p{L}/u.test(en)) return { usable: false, reason: "numeric", match: en };

  // O fornecedor às vezes preenche o campo en-UK com o espanhol tal e qual.
  if (normalizeForCompare(en) === normalizeForCompare(originalEs)) {
    return { usable: false, reason: "untranslated" };
  }

  const punct = en.match(SPANISH_PUNCTUATION_RE);
  if (punct) return { usable: false, reason: "spanish-punctuation", match: punct[0] };

  const noun = en.match(SPANISH_NOUN_RE);
  if (noun) return { usable: false, reason: "spanish-noun", match: noun[0] };

  return { usable: true, reason: "ok" };
}

/** @param {string} supplierEn @param {string} originalEs */
export function isUsableSupplierTitle(supplierEn, originalEs) {
  return evaluateSupplierTitle(supplierEn, originalEs).usable;
}
