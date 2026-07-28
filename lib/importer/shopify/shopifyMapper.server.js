import { toEnglishFacetLabel } from "../catalog/facetRegistry.server.js";
import { translateCategoryLabel } from "../catalog/categoryLabel.js";

/** Margem de retalho automática (+40% sobre custo líquido). */
export const SHOPIFY_RETAIL_MARGIN = 1.4;

/** Tags que identificam produtos criados/importados pela Alterpop. */
export const ALTERPOP_APP_TAGS = ["alterpop", "ociostock"];

/** Peso por defeito (kg) quando o CSV não traz peso — evita falhas de envio na Shopify. */
export const DEFAULT_SHOPIFY_WEIGHT_KG = 0.5;

/**
 * EAN / código de barras do fornecedor (BD). Fallback: SKU.
 * @param {{ sku?: string, barcode?: string|null }} product
 */
export function resolveShopifyBarcode(product) {
  const barcode = String(product.barcode || "").trim();
  const sku = String(product.sku || "").trim();
  return barcode || sku;
}

/**
 * Peso em quilogramas para a variante Shopify.
 * @param {{ weightKg?: number|null, weight?: number|null, weightGrams?: number|null }} product
 */
export function resolveShopifyWeightKg(product) {
  const kg = product.weightKg ?? product.weight;
  if (kg != null && Number.isFinite(Number(kg)) && Number(kg) > 0) {
    return Math.round(Number(kg) * 1000) / 1000;
  }
  const grams = product.weightGrams;
  if (grams != null && Number.isFinite(Number(grams)) && Number(grams) > 0) {
    return Math.round((Number(grams) / 1000) * 1000) / 1000;
  }
  return DEFAULT_SHOPIFY_WEIGHT_KG;
}

/**
 * @param {number|null|undefined} netPrice
 */
export function computeShopifyRetailPrice(netPrice) {
  if (netPrice == null || !Number.isFinite(netPrice) || netPrice <= 0) return null;
  return Math.round(netPrice * SHOPIFY_RETAIL_MARGIN * 100) / 100;
}

/**
 * @param {unknown} jsonField
 */
function parseJsonArray(jsonField) {
  try {
    const parsed = JSON.parse(String(jsonField || "[]"));
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * @param {string|null|undefined} vendor
 * @param {string[]} franchises
 */
export function buildShopifyProductTags(vendor, franchises = [], customTags = []) {
  const tags = new Set();
  if (vendor?.trim()) tags.add(vendor.trim());
  for (const ref of franchises) {
    const label = toEnglishFacetLabel(ref);
    if (label) tags.add(label);
    else if (ref?.trim()) tags.add(ref.trim());
  }
  for (const t of ALTERPOP_APP_TAGS) tags.add(t);
  for (const ct of customTags) {
    if (ct?.trim()) tags.add(ct.trim());
  }
  return [...tags];
}

/**
 * @param {string|null|undefined} categoryMain
 */
export function resolveShopifyProductType(categoryMain) {
  if (!categoryMain) return undefined;
  const en = toEnglishFacetLabel(categoryMain);
  if (en) return en;
  return translateCategoryLabel(categoryMain) || categoryMain;
}

/**
 * @param {{
 *   sku: string,
 *   title: string,
 *   vendor?: string|null,
 *   categoryMain?: string|null,
 *   categorySegments?: string,
 *   franchises?: string,
 *   stock?: number,
 *   netPrice?: number|null,
 *   grossPrice?: number|null,
 *   imageUrl?: string|null,
 * }} product
 */
export function buildProductDescriptionHtml(product) {
  const segments = parseJsonArray(product.categorySegments);
  const franchises = parseJsonArray(product.franchises);
  const retail = computeShopifyRetailPrice(product.netPrice);
  const categoryEn = resolveShopifyProductType(product.categoryMain);

  const rows = [
    ["SKU", product.sku],
    ["Marca", product.vendor || "—"],
    ["Tipo", categoryEn || "—"],
    ["Stock fornecedor", String(product.stock ?? 0)],
    ["Preço custo (net)", product.netPrice != null ? `${product.netPrice.toFixed(2)} €` : "—"],
    ["Preço loja (PVP)", retail != null ? `${retail.toFixed(2)} €` : "—"],
  ];

  if (segments.length) {
    rows.push(["Categorias", segments.join(" › ")]);
  }
  if (franchises.length) {
    rows.push([
      "Licenças / IP",
      franchises.map((f) => toEnglishFacetLabel(f) || f).join(", "),
    ]);
  }

  const bodyRows = rows
    .map(
      ([label, value]) =>
        `<tr><th style="text-align:left;padding:8px 12px;background:#f6f6f7;border:1px solid #e3e3e3;">${escapeHtml(label)}</th><td style="padding:8px 12px;border:1px solid #e3e3e3;">${escapeHtml(value)}</td></tr>`
    )
    .join("");

  return `<p>Produto importado pela Alterpop (OcioStock).</p>
<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px;">
  <tbody>${bodyRows}</tbody>
</table>`;
}

/**
 * Mapeia linha CatalogProduct (SQLite) → payload Shopify Admin GraphQL + REST de referência.
 * @param {{
 *   sku: string,
 *   title: string,
 *   vendor?: string|null,
 *   categoryMain?: string|null,
 *   categorySegments?: string,
 *   franchises?: string,
 *   stock?: number,
 *   netPrice?: number|null,
 *   grossPrice?: number|null,
 *   barcode?: string|null,
 *   imageUrl?: string|null,
 *   weightKg?: number|null,
 * }} product
 * @param {{ status?: 'ACTIVE' | 'DRAFT', customTags?: string[] }} [opts]
 */
export function mapCatalogProductToShopifyPayload(product, opts = {}) {
  const franchises = parseJsonArray(product.franchises);
  const sku = String(product.sku || "").trim();
  const vendor = String(product.vendor || "").trim() || undefined;
  const barcode = resolveShopifyBarcode(product);
  const weightKg = resolveShopifyWeightKg(product);
  const tags = buildShopifyProductTags(vendor, franchises, opts.customTags || []);
  const productType = resolveShopifyProductType(product.categoryMain);
  const retailPrice = computeShopifyRetailPrice(product.netPrice);
  const descriptionHtml = buildProductDescriptionHtml({ ...product, vendor, sku });
  const status = opts.status || "ACTIVE";
  const stock = Math.max(0, Math.floor(Number(product.stock ?? product.availableQuantity) || 0));

  return {
    sku,
    title: product.title || `Product ${sku}`,
    vendor,
    barcode,
    weightKg,
    productType,
    descriptionHtml,
    status,
    tags,
    retailPrice,
    netPrice: product.netPrice,
    stock,
    imageUrl: product.imageUrl?.trim() || null,
    /** Equivalente REST `POST /admin/api/.../products.json` */
    restProduct: {
      product: {
        title: product.title,
        body_html: descriptionHtml,
        vendor: product.vendor || undefined,
        product_type: productType,
        tags: tags.join(", "),
        status: status === "ACTIVE" ? "active" : "draft",
        variants: [
          {
            sku,
            barcode,
            weight: weightKg,
            weight_unit: "kg",
            price: retailPrice != null ? String(retailPrice) : undefined,
            inventory_management: "shopify",
            inventory_policy: "deny",
          },
        ],
        images: product.imageUrl ? [{ src: product.imageUrl }] : [],
      },
    },
    /** `productCreate` GraphQL */
    graphql: {
      product: {
        title: product.title || `Product ${product.sku}`,
        descriptionHtml,
        vendor: product.vendor || undefined,
        productType,
        status,
        tags,
      },
      variant: {
        sku,
        price: retailPrice != null ? String(retailPrice) : undefined,
        barcode,
        weight: weightKg,
        weightUnit: "KILOGRAMS",
        inventoryPolicy: "DENY",
      },
      media: product.imageUrl
        ? [{ originalSource: product.imageUrl, mediaContentType: "IMAGE" }]
        : [],
    },
  };
}

/**
 * @param {string} text
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
