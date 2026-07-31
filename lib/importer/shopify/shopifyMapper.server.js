import { toEnglishFacetLabel } from "../catalog/facetRegistry.server.js";
import { translateCategoryLabel } from "../catalog/categoryLabel.js";

/** Margem de retalho automática (+40% sobre custo líquido). */
export const SHOPIFY_RETAIL_MARGIN = 1.4;

/** Tags que identificam produtos criados/importados pela Alterpop. */
export const ALTERPOP_APP_TAGS = ["alterpop", "ociostock"];

/** Peso por defeito (kg) quando o CSV não traz peso — evita falhas de envio na Shopify. */
export const DEFAULT_SHOPIFY_WEIGHT_KG = 0.5;

/**
 * EAN / código de barras do fornecedor (BD). Não usa SKU como fallback para evitar erros de validação de barcode na Shopify.
 * @param {{ sku?: string, barcode?: string|null }} product
 */
export function resolveShopifyBarcode(product) {
  const barcode = String(product.barcode || "").trim();
  if (!barcode) return undefined;
  const clean = barcode.replace(/[\r\n\t]/g, "").trim();
  return clean || undefined;
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
 * @param {string[]} customTags
 */
export function buildShopifyProductTags(vendor, franchises = [], customTags = []) {
  const tags = new Set();

  const addTag = (raw) => {
    if (!raw) return;
    const parts = String(raw).split(",");
    for (const part of parts) {
      const clean = part.trim().replace(/[\r\n\t]/g, "");
      if (clean) tags.add(clean);
    }
  };

  if (vendor?.trim()) addTag(vendor);
  for (const ref of franchises) {
    const label = toEnglishFacetLabel(ref);
    if (label) addTag(label);
    else if (ref?.trim()) addTag(ref);
  }
  for (const t of ALTERPOP_APP_TAGS) addTag(t);
  for (const ct of customTags) addTag(ct);

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
 * Limpa strings de categoria/faceta e remove prefixos internos como [UNTRANSLATED].
 * @param {string} raw
 */
function cleanUserFacingLabel(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";
  text = text.replace(/^\[UNTRANSLATED\]\s*/gi, "").trim();
  const en = toEnglishFacetLabel(text);
  return en || text;
}

/**
 * Converte um nome/faceta em um slug/handle limpo para coleções Shopify (/collections/<slug>).
 * @param {string} name
 */
function toCollectionSlug(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Gera a descrição HTML pública para o cliente na loja Shopify.
 * 100% focada no cliente final, sem dados de fornecedor ou custos internos.
 * @param {{
 *   sku: string,
 *   title: string,
 *   vendor?: string|null,
 *   categoryMain?: string|null,
 *   categorySegments?: string,
 *   franchises?: string,
 *   barcode?: string|null,
 * }} product
 */
export function buildProductDescriptionHtml(product) {
  const title = (product.title || `Produto ${product.sku}`).replace(/[\r\n\t]/g, " ").trim();
  const vendor = product.vendor?.trim() || null;
  const categoryEn = resolveShopifyProductType(product.categoryMain);
  const cleanCategory = cleanUserFacingLabel(categoryEn);

  const rawFranchises = parseJsonArray(product.franchises);
  const cleanFranchises = Array.from(
    new Set(rawFranchises.map(cleanUserFacingLabel).filter(Boolean))
  );

  // Parágrafo comercial apelativo
  let intro = `<p><strong>${escapeHtml(title)}</strong> é um artigo oficial de coleção de alta qualidade`;
  if (vendor) {
    intro += ` licenciado por <strong>${escapeHtml(vendor)}</strong>`;
  }
  intro += `. Ideal para fãs, colecionadores e entusiastas da cultura pop.</p>`;

  const specRows = [];

  // SKU / Referência
  specRows.push(`<tr>
    <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;width:35%;font-weight:600;color:#212529;">SKU / Referência</th>
    <td style="padding:10px 14px;border:1px solid #e9ecef;color:#495057;">${escapeHtml(product.sku)}</td>
  </tr>`);

  // Marca / Fabricante com link interno de pesquisa/coleção
  if (vendor) {
    const brandUrl = `/collections/all?filter.p.vendor=${encodeURIComponent(vendor)}`;
    specRows.push(`<tr>
      <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">Marca / Fabricante</th>
      <td style="padding:10px 14px;border:1px solid #e9ecef;"><a href="${brandUrl}" style="color:#005bd3;text-decoration:underline;font-weight:500;">${escapeHtml(vendor)}</a></td>
    </tr>`);
  }

  // Categoria / Tipo com link interno
  if (cleanCategory) {
    const catUrl = `/collections/all?filter.p.product_type=${encodeURIComponent(cleanCategory)}`;
    specRows.push(`<tr>
      <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">Categoria</th>
      <td style="padding:10px 14px;border:1px solid #e9ecef;"><a href="${catUrl}" style="color:#005bd3;text-decoration:underline;font-weight:500;">${escapeHtml(cleanCategory)}</a></td>
    </tr>`);
  }

  // Licenças / Universos com links internos de coleção
  if (cleanFranchises.length > 0) {
    const franchiseLinks = cleanFranchises.map((f) => {
      const slug = toCollectionSlug(f);
      const url = slug ? `/collections/${slug}` : `/collections/all`;
      return `<a href="${url}" style="color:#005bd3;text-decoration:underline;font-weight:500;">${escapeHtml(f)}</a>`;
    }).join(", ");

    specRows.push(`<tr>
      <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">Licença / Universo</th>
      <td style="padding:10px 14px;border:1px solid #e9ecef;">${franchiseLinks}</td>
    </tr>`);
  }

  // EAN / Código de barras se disponível
  if (product.barcode) {
    const cleanBarcode = String(product.barcode).trim();
    if (cleanBarcode) {
      specRows.push(`<tr>
        <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">EAN / Código de Barras</th>
        <td style="padding:10px 14px;border:1px solid #e9ecef;color:#495057;">${escapeHtml(cleanBarcode)}</td>
      </tr>`);
    }
  }

  const tableHtml = specRows.length > 0
    ? `<div style="margin-top:20px;">
        <h4 style="margin:0 0 10px 0;font-size:15px;font-weight:600;color:#212529;">Especificações do Produto</h4>
        <table style="width:100%;border-collapse:collapse;margin:0 0 16px 0;font-size:14px;border:1px solid #e9ecef;border-radius:8px;overflow:hidden;">
          <tbody>${specRows.join("")}</tbody>
        </table>
      </div>`
    : "";

  const guaranteeHtml = `<p style="font-size:13px;color:#6c757d;margin-top:16px;font-style:italic;">✓ Produto 100% oficial e com licença autêntica. Envio rápido e embalagem protegida.</p>`;

  return `${intro}${tableHtml}${guaranteeHtml}`;
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
/**
 * Extrai todas as URLs de imagem (principal + secundárias) e codifica adequadamente.
 * @param {object} product
 * @returns {string[]}
 */
export function extractAllImageUrls(product) {
  const urls = [];

  const add = (raw) => {
    if (!raw) return;
    const str = String(raw).trim();
    const parts = str.split(/[,;|\n\r]+/);
    for (const p of parts) {
      const clean = p.trim().replace(/^["']|["']$/g, "");
      if (clean && /^https?:\/\/[^\s]+/i.test(clean)) {
        try {
          urls.push(encodeURI(clean));
        } catch {
          urls.push(clean);
        }
      }
    }
  };

  add(product.imageUrl);
  add(product.imageUrlLarge);
  if (Array.isArray(product.extraImages)) {
    for (const img of product.extraImages) add(img);
  } else {
    add(product.extraImages);
  }

  return Array.from(new Set(urls));
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
 *   imageUrlLarge?: string|null,
 *   extraImages?: string[]|string|null,
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

  const allImages = extractAllImageUrls(product);
  const cleanImgUrl = allImages[0] || null;
  const title = (product.title || `Product ${sku}`).replace(/[\r\n\t]/g, " ").trim();

  return {
    sku,
    title,
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
    imageUrl: cleanImgUrl,
    allImages,
    /** Equivalente REST `POST /admin/api/.../products.json` */
    restProduct: {
      product: {
        title,
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
        images: allImages.map((src) => ({ src })),
      },
    },
    /** `productCreate` GraphQL */
    graphql: {
      product: {
        title,
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
      media: allImages.map((src) => ({
        originalSource: src,
        mediaContentType: "IMAGE",
      })),
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
