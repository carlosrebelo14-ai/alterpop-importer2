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
function splitCategoryPath(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const segments = text
    .split(/[|/]/)
    .map((s) => s.trim())
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
