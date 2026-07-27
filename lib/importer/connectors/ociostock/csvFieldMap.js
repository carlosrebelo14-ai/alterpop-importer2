/**
 * OcioStock CSV (Spanish headers) → internal ProductRecord (English fields).
 */

import {
  parseCategorySegments,
  parseFranchiseRefs,
  parseExtraImages,
  parseProductTypePath,
} from "./parseFamilies.js";

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
  const s = String(value).trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).trim();
  return s;
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

  const skuRaw =
    firstMappedValue(row, csvToRecord, "sku", ["referencia", "ean"]) ||
    firstMappedValue(row, csvToRecord, "barcode", ["ean"]);
  const sku = stripQuotes(skuRaw);
  if (!sku) return null;

  const categoryRaw = stripQuotes(
    firstMappedValue(row, csvToRecord, "category", ["categoria_principal"])
  );
  const titleRaw = stripQuotes(firstMappedValue(row, csvToRecord, "title", ["nombre"]));
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

  const record = {
    sku,
    barcode: stripQuotes(firstMappedValue(row, csvToRecord, "barcode", ["ean"])) || sku,
    supplierProductId: stripQuotes(
      firstMappedValue(row, csvToRecord, "supplierProductId", ["id_producto"])
    ),
    title: titleRaw,
    description: descriptionRaw,
    category: categoryRaw,
    categoryMain,
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
    extraImages: parseExtraImages(stripQuotes(row.csv_imagenes)),
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
      parseFloatSafe(row.peso_producto),
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
