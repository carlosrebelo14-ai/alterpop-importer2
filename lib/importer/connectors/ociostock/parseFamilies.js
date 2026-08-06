/**
 * Parse de franchises e árvore de categorias OcioStock (xml_info_familias, categoria_principal, product_type_path).
 */

/**
 * Extrai blocos CDATA e texto interior de tags XML do fornecedor.
 * @param {string} xml
 * @returns {string[]}
 */
function extractXmlTextTokens(xml) {
  if (!xml) return [];
  const tokens = [];

  const cdataRe = /<!\[CDATA\[([^\]]*)\]\]>/gi;
  let m;
  while ((m = cdataRe.exec(xml)) !== null) {
    if (m[1]?.trim()) tokens.push(m[1].trim());
  }

  const innerRe = /<category[^>]*>([^<]+)<\/category>/gi;
  while ((m = innerRe.exec(xml)) !== null) {
    const inner = m[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    if (inner) tokens.push(inner);
  }

  return tokens;
}

/**
 * Divide caminhos de categoria (pipe ou barra) em segmentos úteis para matching.
 * @param {string} raw
 * @returns {string[]}
 */
/**
 * Abreviaturas do fornecedor com barra interna: "M/C" (manga corta), "M/L" (manga larga).
 * Nunca são separadores de caminho — 1 a 2 letras de cada lado, sem espaços.
 * Distingue-se de separadores reais como "PAPELERIA / ESCOLAR" ou "CUADERNOS/BLOC",
 * onde pelo menos um dos lados é uma palavra inteira.
 */
const ABBREVIATION_SLASH_RE = /(?<![\p{L}\p{N}])(\p{L}{1,2})\/(\p{L}{1,2})(?![\p{L}\p{N}])/gu;
/** Sentinela em Private Use Area — não ocorre em texto de catálogo. */
const SLASH_SENTINEL = "";

function splitCategoryPath(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  // Protege as abreviaturas antes de partir, restaura depois: "CAMISETAS M/C" era
  // partido em "CAMISETAS M" + "C", poluindo os tokens de franquia com um "C" solto.
  const protectedText = text.replace(ABBREVIATION_SLASH_RE, `$1${SLASH_SENTINEL}$2`);
  const segments = protectedText
    .split(/[|/]/)
    .map((s) => s.replaceAll(SLASH_SENTINEL, "/").trim())
    .filter(Boolean);
  return segments;
}

/**
 * @param {string} value
 * @param {Set<string>} bucket
 */
function addFranchiseTokens(value, bucket) {
  for (const part of splitCategoryPath(value)) {
    if (part) bucket.add(part);
  }
}

/**
 * Extrai sinais de franchise do feed OcioStock.
 *
 * Fontes:
 * - Atributos ref="..." em xml_info_familias
 * - CDATA e texto das categorias XML (árvore completa do fornecedor)
 * - categoria_principal (segmentos pipe)
 * - product_type_path em xml_campos_dinamicos
 *
 * @param {string} xmlFamilies - coluna xml_info_familias
 * @param {object} [context]
 * @param {string} [context.categoryRaw] - categoria_principal
 * @param {string} [context.productTypeXml] - xml_campos_dinamicos
 * @returns {string[]}
 */
export function parseFranchiseRefs(xmlFamilies, context = {}) {
  const bucket = new Set();

  if (xmlFamilies) {
    const refRe = /ref="([^"]+)"/gi;
    let m;
    while ((m = refRe.exec(xmlFamilies)) !== null) {
      if (m[1]?.trim()) bucket.add(m[1].trim());
    }

    for (const token of extractXmlTextTokens(xmlFamilies)) {
      addFranchiseTokens(token, bucket);
    }
  }

  const { categoryRaw, productTypeXml } = context;

  if (categoryRaw) {
    addFranchiseTokens(categoryRaw, bucket);
  }

  if (productTypeXml) {
    const { path, segments } = parseProductTypePath(productTypeXml);
    if (path) addFranchiseTokens(path, bucket);
    for (const seg of segments) {
      if (seg) bucket.add(seg);
    }
    for (const token of extractXmlTextTokens(productTypeXml)) {
      addFranchiseTokens(token, bucket);
    }
  }

  return [...bucket];
}

/**
 * @param {string} categoryRaw
 * @returns {{ categoryMain: string, categorySegments: string[] }}
 */
export function parseCategorySegments(categoryRaw) {
  const raw = String(categoryRaw || "").trim();
  if (!raw) return { categoryMain: "", categorySegments: [] };
  const segments = raw
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    categoryMain: segments[0] || "",
    categorySegments: segments,
  };
}

/**
 * @param {string} ref
 */
export function humanizeFranchiseRef(ref) {
  if (!ref) return "";
  return ref
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .trim();
}

/**
 * Extrai product_type_path do XML OcioStock (ex: PAPELERIA / ESCOLAR|BOLÍGRAFOS).
 * @param {string} xml
 */
export function parseProductTypePath(xml) {
  if (!xml) return { path: "", segments: [] };
  const match = String(xml).match(/product_type_path="([^"]+)"/i);
  if (!match?.[1]) return { path: "", segments: [] };

  const path = match[1].trim();
  const segments = path
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  return { path, segments };
}

/**
 * Campos do ProductRecord usados para detetar franchises prioritárias (curadoria).
 * @param {import('../../types.js').ProductRecord} record
 * @returns {string[]}
 */
export function collectFranchiseHaystacks(record) {
  const parts = [];

  const add = (value) => {
    for (const segment of splitCategoryPath(value)) {
      if (segment) parts.push(segment);
    }
  };

  for (const ref of record.franchises || []) {
    add(ref);
    add(humanizeFranchiseRef(ref));
  }

  add(record.title);
  add(record.description);
  add(record.category);
  add(record.categoryMain);
  add(record.productTypePath);
  add(record._source?.category);

  for (const seg of record.categorySegments || []) {
    add(seg);
  }

  return [...new Set(parts.map((p) => String(p).trim()).filter(Boolean))];
}

/**
 * Peso de envio do fornecedor (coluna `xml_info_peso`), formato
 * `<shipping_weight unit="g">274</shipping_weight>`. Converte sempre para kg.
 * @param {string} xmlPeso
 * @returns {number|null}
 */
export function parseShippingWeightKg(xmlPeso) {
  if (!xmlPeso) return null;
  const match = String(xmlPeso).match(
    /<shipping_weight[^>]*unit=["']?([a-zA-Z]+)["']?[^>]*>\s*([\d.,]+)\s*<\/shipping_weight>/i
  );
  if (!match) return null;
  const unit = match[1].trim().toLowerCase();
  const value = parseFloat(match[2].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === "kg") return value;
  if (unit === "g") return value / 1000;
  return null;
}

/**
 * @param {string} csvImages
 * @returns {string[]}
 */
export function parseExtraImages(csvImages) {
  if (!csvImages) return [];
  return csvImages
    .split(/[,;|\s]+/)
    .map((u) => u.trim().replace(/^["']|["']$/g, ""))
    .filter((u) => u.startsWith("http"));
}

/**
 * Título oficial em inglês fornecido pela OcioStock (coluna `xml_info_otros_idiomas`),
 * formato:
 *   <internationalization>
 *     <title>
 *       <value lang="es-ES"><![CDATA[...]]></value>
 *       <value lang="en-UK"><![CDATA[...]]></value>
 *     </title>
 *     <description>... (também tem en-UK — NÃO é o que queremos) ...</description>
 *   </internationalization>
 *
 * Presente em 99,8% das linhas e nunca usado até 2026-08-04. Isola primeiro o bloco
 * <title> para não apanhar por engano o en-UK da <description>.
 *
 * @param {string} xmlOtherLanguages
 * @param {string} [lang="en-UK"]
 * @returns {string} título em inglês, ou "" se não existir
 */
export function parseSupplierTitleByLang(xmlOtherLanguages, lang = "en-UK") {
  if (!xmlOtherLanguages) return "";
  const titleBlock = String(xmlOtherLanguages).match(/<title>([\s\S]*?)<\/title>/i);
  if (!titleBlock) return "";
  const escaped = lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = titleBlock[1].match(
    new RegExp(`<value[^>]*lang=["']?${escaped}["']?[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</value>`, "i")
  );
  return value ? value[1].trim() : "";
}

/**
 * Dimensões da embalagem (coluna `xml_info_dimensiones`), formato
 * `<size unit="mm"><width>250</width><height>50</height><depth>150</depth></size>`.
 * Presente em 21.258 de 30.835 produtos (~69%) — os restantes devolvem null e não
 * geram linha na tabela de especificações nem metafield.
 *
 * O feed usa sempre mm (verificado nas 21.258 linhas a 2026-08-04), mas o atributo
 * `unit` é lido em vez de assumido, para o dia em que mudar. Devolve string já
 * formatada em cm — é a unidade legível para o comprador, e evita três colunas
 * numéricas na BD para um dado que só é usado para exibição.
 *
 * @param {string} xmlSize
 * @returns {string|null} ex: "25 × 5 × 15 cm", ou null se não houver dados válidos
 */
export function parseDimensions(xmlSize) {
  if (!xmlSize) return null;
  const raw = String(xmlSize);

  const unitMatch = raw.match(/<size[^>]*unit=["']?([a-zA-Z]+)["']?/i);
  const unit = (unitMatch?.[1] || "mm").toLowerCase();
  /** fator de conversão para cm */
  const toCm = unit === "mm" ? 0.1 : unit === "cm" ? 1 : unit === "m" ? 100 : null;
  if (toCm == null) return null;

  const read = (tag) => {
    const m = raw.match(new RegExp(`<${tag}>\\s*([\\d.,]+)\\s*</${tag}>`, "i"));
    if (!m) return null;
    const v = parseFloat(m[1].replace(",", "."));
    return Number.isFinite(v) && v > 0 ? v * toCm : null;
  };

  const dims = [read("width"), read("height"), read("depth")];
  if (dims.some((d) => d == null)) return null;

  // Sem zeros à direita: 25.0 -> "25", 12.5 -> "12.5"
  return `${dims.map((d) => String(parseFloat(d.toFixed(1)))).join(" × ")} cm`;
}

/**
 * Código HS / pauta aduaneira (coluna `hs_intrastat_code`), preenchida em ~90,7% do feed.
 *
 * O fornecedor não normaliza o formato. Levantamento a 2026-08-06 sobre 27.978 valores:
 *   8 dígitos  24.711  nomenclatura combinada da UE — o formato desejado
 *  10 dígitos   2.011  TARIC, trunca para os 8 significativos
 *   7 dígitos     516  trunca para HS6 em vez de inventar o 8.º dígito
 *   6 dígitos     318  HS internacional, válido tal como está
 *  12 dígitos     379  "9503 0089 00" — espaços, trunca para 8
 *  16 dígitos      17  "9504.40.00.00.00" — pontos, trunca para 8
 *  15 dígitos       1  "761510 / 392410" — dois códigos, fica o primeiro
 *  13+ dígitos      4  "8425611310447 tails" — é EAN, não HS: rejeitado
 *
 * Princípio: nunca inventar dígitos. Truncar é seguro (um prefixo HS continua a ser uma
 * classificação válida, só menos específica); preencher à direita seria fabricar uma
 * posição pautal que pode não existir. Declaração aduaneira errada é pior que vazia.
 *
 * @param {string} raw
 * @returns {string|null} 6 ou 8 dígitos, ou null se não for aproveitável
 */
export function parseHsCode(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  // "761510 / 392410" são dois códigos alternativos — fica o primeiro.
  const firstCandidate = text.split("/")[0];
  const digits = firstCandidate.replace(/\D/g, "");
  if (!digits) return null;

  // 13+ dígitos não é pauta aduaneira: no feed são códigos de barras EAN.
  if (digits.length > 12) return null;

  const code = digits.length >= 8 ? digits.slice(0, 8) : digits.slice(0, 6);
  if (code.length !== 8 && code.length !== 6) return null;

  // Capítulo 01-99; "00" não existe na nomenclatura.
  const chapter = Number(code.slice(0, 2));
  if (!Number.isFinite(chapter) || chapter < 1 || chapter > 99) return null;

  return code;
}
