/**
 * OcioStock CSV (Spanish headers) → internal ProductRecord (English fields).
 */

import {
  parseCategorySegments,
  parseFranchiseRefs,
  parseExtraImages,
  parseProductTypePath,
  parseShippingWeightKg,
  parseSupplierTitleByLang,
  parseDimensions,
} from "./parseFamilies.js";
import { translateTitleFromGlossary } from "../../transform/glossary/translateTitle.js";
import { evaluateSupplierTitle } from "../../transform/supplierTitle.js";

/**
 * Valores que aparecem em `categoria_principal` sem serem categorias reais —
 * são flags de estado interno do fornecedor (ex: XON/XOFF, provavelmente
 * "listing ativo/inativo") que por engano ficam na coluna de categoria.
 * Confirmado: xml_campos_dinamicos (product_type_path) tem sempre a
 * categoria real nestes casos.
 */
const JUNK_CATEGORY_VALUES = new Set(["XON", "XOFF"]);

/** @param {string} value */
function isJunkCategoryValue(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  return JUNK_CATEGORY_VALUES.has(v.toUpperCase()) || /^\d+$/.test(v);
}

export const DEFAULT_CSV_TO_RECORD = {
  referencia: "sku",
  ean: "barcode",
  stock_disponible: "availableQuantity",
  hay_stock: "hasStock",
  nombre: "title",
  descripcion: "description",
  categoria_principal: "category",
  marca: "vendor",
  precio_neto: "netPrice",
  precio_bruto: "grossPrice",
  peso: "weightKg",
  peso_kg: "weightKg",
  peso_producto: "weightKg",
  id_producto: "supplierProductId",
  url_imagen_principal: "imageUrl",
  url_imagen_principal_grande: "imageUrlLarge",
  disponibilidad: "availability",
  tipo_promocion: "promotionType",
};

let activeCsvToRecordOverrides = {};

export function createCsvToRecordMap(overrides = {}) {
  return {
    ...DEFAULT_CSV_TO_RECORD,
    ...(overrides || {}),
  };
}

export function setActiveCsvColumnMap(overrides = {}) {
  activeCsvToRecordOverrides = { ...(overrides || {}) };
}

export function getActiveCsvColumnMap() {
  return { ...activeCsvToRecordOverrides };
}

/** Fields translated ES → EN before Shopify sync */
export const TRANSLATABLE_FIELDS = ["title", "description", "category", "categoryMain"];

function stripQuotes(value) {
  if (value == null) return "";
  let s = String(value).trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  // V8 substring memory leak fix: force new string allocation
  // so the large CSV chunk buffer can be garbage collected
  return (' ' + s).slice(1);
}

/**
 * Extrai todas as imagens secundárias/adicionais das várias colunas possíveis do CSV OcioStock.
 * @param {Record<string, any>} row
 * @returns {string[]}
 */
function collectAllCsvExtraImages(row) {
  const urls = [];
  const add = (val) => {
    if (!val) return;
    const parsed = parseExtraImages(stripQuotes(val));
    for (const u of parsed) {
      if (u && !urls.includes(u)) urls.push(u);
    }
  };

  add(row.csv_imagenes);
  add(row.url_imagenes_adicionales);
  add(row.imagenes_adicionales);
  add(row.url_imagenes);
  add(row.urls_imagenes);
  add(row.url_imagen_secundaria_1);
  add(row.url_imagen_secundaria_2);
  add(row.url_imagen_secundaria_3);
  add(row.url_imagen_secundaria_4);
  add(row.url_imagen_secundaria_5);
  add(row.imagen_2);
  add(row.imagen_3);
  add(row.imagen_4);
  add(row.imagen_5);
  add(row.imagen2);
  add(row.imagen3);
  add(row.imagen4);
  add(row.imagen5);

  return urls;
}

function parseBoolean(value) {
  const s = stripQuotes(value);
  return s === "1" || s.toLowerCase() === "true";
}

function parseIntSafe(value, fallback = 0) {
  const n = parseInt(stripQuotes(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatSafe(value) {
  const n = parseFloat(stripQuotes(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Record<string, string>} row
 * @returns {import('../../types.js').ProductRecord | null}
 */
function firstMappedValue(row, map, recordField, fallbackKeys = []) {
  const mappedKeys = Object.entries(map)
    .filter(([, target]) => target === recordField)
    .map(([csvKey]) => csvKey);
  const ordered = [...mappedKeys, ...fallbackKeys];
  for (const key of ordered) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return row[key];
    }
  }
  return null;
}

/**
 * Mapeador genérico para CSVs multi-mercado (dicionário dinâmico de colunas).
 * @param {Record<string, string>} row
 * @param {{
 *   csvToRecord?: Record<string, string>,
 *   familiesXmlField?: string,
 *   dynamicFieldsXmlField?: string,
 * }} [opts]
 * @returns {import('../../types.js').ProductRecord | null}
 */
export function mapCsvRow(row, opts = {}) {
  const csvToRecord = createCsvToRecordMap(opts.csvToRecord);
  const familiesXmlField = opts.familiesXmlField || "xml_info_familias";
  const dynamicFieldsXmlField = opts.dynamicFieldsXmlField || "xml_campos_dinamicos";
  const otherLanguagesXmlField = opts.otherLanguagesXmlField || "xml_info_otros_idiomas";
  const dimensionsXmlField = opts.dimensionsXmlField || "xml_info_dimensiones";

  const skuRaw =
    firstMappedValue(row, csvToRecord, "sku", ["referencia", "ean"]) ||
    firstMappedValue(row, csvToRecord, "barcode", ["ean"]);
  const sku = stripQuotes(skuRaw);
  if (!sku) return null;

  const categoryRaw = stripQuotes(
    firstMappedValue(row, csvToRecord, "category", ["categoria_principal"])
  );
  const titleRaw = stripQuotes(firstMappedValue(row, csvToRecord, "title", ["nombre"]));

  // Fonte primária do título: o inglês oficial que a OcioStock já envia (99,8% das linhas).
  // Quando passa no detetor de qualidade, o pipeline de tradução não chega a correr — nem
  // aqui nem em transformRow (que verifica `titleSource`). Quando não passa, cai no
  // comportamento anterior, inalterado. Ver lib/importer/transform/supplierTitle.js.
  const supplierTitleEn = parseSupplierTitleByLang(stripQuotes(row[otherLanguagesXmlField]));
  const supplierTitle = evaluateSupplierTitle(supplierTitleEn, titleRaw);
  const titleTranslated = supplierTitle.usable
    ? supplierTitleEn
    : translateTitleFromGlossary(titleRaw);
  const descriptionRaw = stripQuotes(
    firstMappedValue(row, csvToRecord, "description", ["descripcion"])
  );
  const productTypeXml = stripQuotes(row[dynamicFieldsXmlField]);
  const { categoryMain, categorySegments } = parseCategorySegments(categoryRaw);
  const franchiseRefs = parseFranchiseRefs(stripQuotes(row[familiesXmlField]), {
    categoryRaw,
    productTypeXml,
    title: titleRaw,
    description: descriptionRaw,
  });
  const franchises = [...new Set(franchiseRefs)];
  const { path: productTypePath, segments: productTypeSegments } = parseProductTypePath(productTypeXml);
  const allCategorySegments = [
    ...new Set([...categorySegments, ...productTypeSegments]),
  ];

  // categoria_principal às vezes vem com um flag de estado do fornecedor
  // (XON/XOFF) em vez de uma categoria — usa product_type_path como fallback,
  // que tem a categoria real nesses casos. Sem fallback disponível, mantém
  // o comportamento atual (não inventa categoria nova).
  let effectiveCategoryMain = categoryMain;
  if (isJunkCategoryValue(categoryMain)) {
    const fallback = productTypePath.split("|")[0]?.trim();
    if (fallback) {
      effectiveCategoryMain = fallback;
    }
  }

  const record = {
    sku,
    barcode: stripQuotes(firstMappedValue(row, csvToRecord, "barcode", ["ean"])) || sku,
    supplierProductId: stripQuotes(
      firstMappedValue(row, csvToRecord, "supplierProductId", ["id_producto"])
    ),
    title: titleTranslated,
    supplierTitleEn,
    /** "supplier" = título veio pronto do fornecedor; "pipeline" = glossário + API */
    titleSource: supplierTitle.usable ? "supplier" : "pipeline",
    /** porque caiu no fallback: empty | numeric | untranslated | spanish-punctuation | spanish-noun */
    titleSourceReason: supplierTitle.reason,
    /** dimensões da embalagem já formatadas ("25 × 5 × 15 cm"); null nos ~31% sem dados */
    dimensions: parseDimensions(stripQuotes(row[dimensionsXmlField])),
    description: descriptionRaw,
    category: categoryRaw,
    categoryMain: effectiveCategoryMain,
    categorySegments: allCategorySegments,
    productTypePath,
    franchises,
    vendor: stripQuotes(firstMappedValue(row, csvToRecord, "vendor", ["marca"])),
    availableQuantity: parseIntSafe(
      firstMappedValue(row, csvToRecord, "availableQuantity", ["stock_disponible"]),
      0
    ),
    hasStock: parseBoolean(firstMappedValue(row, csvToRecord, "hasStock", ["hay_stock"])),
    netPrice: parseFloatSafe(firstMappedValue(row, csvToRecord, "netPrice", ["precio_neto"])),
    grossPrice: parseFloatSafe(firstMappedValue(row, csvToRecord, "grossPrice", ["precio_bruto"])),
    imageUrl: stripQuotes(
      firstMappedValue(row, csvToRecord, "imageUrl", ["url_imagen_principal"])
    ),
    imageUrlLarge: stripQuotes(
      firstMappedValue(row, csvToRecord, "imageUrlLarge", ["url_imagen_principal_grande"])
    ),
    extraImages: collectAllCsvExtraImages(row),
    availability: parseIntSafe(
      firstMappedValue(row, csvToRecord, "availability", ["disponibilidad"]),
      0
    ),
    promotionType: stripQuotes(
      firstMappedValue(row, csvToRecord, "promotionType", ["tipo_promocion"])
    ),
    enLiquidacion: parseBoolean(row.en_liquidacion),
    weightKg:
      parseFloatSafe(firstMappedValue(row, csvToRecord, "weightKg", ["peso"])) ??
      parseFloatSafe(row.peso_kg) ??
      parseFloatSafe(row.peso_producto) ??
      parseShippingWeightKg(row.xml_info_peso),
    _source: {},
  };

  // Aliases genéricos para motor multitenant (independente do fornecedor CSV).
  record.brand = record.vendor;
  record.stock = record.availableQuantity;
  record.price = record.netPrice;

  for (const [csvKey, recordKey] of Object.entries(csvToRecord)) {
    if (row[csvKey] !== undefined) {
      record._source[recordKey] = stripQuotes(row[csvKey]);
    }
  }

  return record;
}

export function mapOcioStockRow(row) {
  return mapCsvRow(row, {
    csvToRecord: createCsvToRecordMap(activeCsvToRecordOverrides),
    familiesXmlField: "xml_info_familias",
    dynamicFieldsXmlField: "xml_campos_dinamicos",
  });
}
