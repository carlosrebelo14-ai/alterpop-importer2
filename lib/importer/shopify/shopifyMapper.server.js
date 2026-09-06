import { toEnglishFacetLabel } from "../catalog/facetRegistry.server.js";
import { translateCategoryLabel } from "../catalog/categoryLabel.js";
import { translateTitleWithApiFallback } from "../transform/translate.js";
import { loadTaxonomyMap } from "../catalog/taxonomy.server.js";
import {
  categoryKeyFromProductTypePath,
  categoryKeyFromSegments,
} from "../catalog/productTypeCategoryMap.js";

/** Margem de retalho automática (+40% sobre custo líquido). */
export const SHOPIFY_RETAIL_MARGIN = 1.4;

/** Tags que identificam produtos criados/importados pela Alterpop. */
export const ALTERPOP_APP_TAGS = ["alterpop"];

/** Peso por defeito (kg) quando o CSV não traz peso — evita falhas de envio na Shopify. */
export const DEFAULT_SHOPIFY_WEIGHT_KG = 0.5;

/**
 * Dimensões por defeito quando o feed não traz `xml_info_dimensiones` (~31% do catálogo).
 * ATENÇÃO: ao contrário do peso — que só alimenta o cálculo de portes — este valor é
 * MOSTRADO ao cliente na tabela de especificações e gravado em ociostock.dimensions.
 * É uma estimativa de embalagem-tipo, não a medida real do produto.
 */
export const DEFAULT_PRODUCT_DIMENSIONS = "22 × 13.7 × 4.2 cm";

/**
 * Dimensões para exibição/metafield: reais quando o fornecedor as envia, genéricas
 * quando não. Aplicado na fronteira da Shopify (mesma convenção de resolveShopifyWeightKg)
 * — a coluna `dimensions` da BD continua a guardar null quando não há dado real, o que
 * permite medir cobertura verdadeira e mudar o default sem reindexar.
 * @param {{ dimensions?: string|null }} product
 */
export function resolveShopifyDimensions(product) {
  const real = String(product?.dimensions || "").trim();
  return real || DEFAULT_PRODUCT_DIMENSIONS;
}

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
 * @param {object} [product]
 */
export function buildShopifyProductTags(vendor, franchises = [], customTags = [], product = {}) {
  const seenLower = new Set();
  const tags = [];

  const addTag = (raw) => {
    if (!raw) return;
    const str = String(raw).trim().replace(/^\[UNTRANSLATED\]\s*/gi, "");
    if (!str) return;

    // Split on commas, pipes, or slashes
    const parts = str.split(/[,|/]+/);
    for (const part of parts) {
      const clean = part.trim().replace(/[\r\n\t]/g, "");
      if (!clean) continue;

      // Reject full titles, sentences, or super long strings (> 35 chars)
      if (clean.length > 35) continue;
      if (clean.split(/\s+/).length > 4) continue;
      if (product.title && clean.toLowerCase() === String(product.title).toLowerCase()) continue;

      // Try English facet label translation first
      const enFacet = toEnglishFacetLabel(clean);
      const finalLabel = enFacet || translateCategoryLabel(clean) || clean;

      const lower = finalLabel.toLowerCase();
      if (!seenLower.has(lower)) {
        seenLower.add(lower);
        tags.push(finalLabel);
      }
    }
  };

  if (vendor?.trim()) addTag(vendor);

  // Add category / product type as a tag for cross-selling & navigation
  const productType = resolveShopifyProductType(product.categoryMain);
  if (productType) addTag(productType);

  for (const ref of franchises) {
    addTag(ref);
  }
  for (const t of ALTERPOP_APP_TAGS) addTag(t);
  for (const ct of customTags) addTag(ct);

  return tags;
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
 * GID da Standard Product Taxonomy da Shopify (campo "category" oficial,
 * separado do "productType" de texto livre) — só devolve algo se houver
 * mapeamento revisto manualmente em taxonomy-map.json > shopifyCategoryIds
 * para este productType. Sem mapeamento, devolve undefined (campo omitido).
 * @param {string|undefined} productType
 * @param {string|string[]|undefined} [typeSource] productTypePath do CSV, ou categorySegments da BD
 */
export function resolveShopifyCategoryGid(productType, typeSource) {
  const { shopifyCategoryIds } = loadTaxonomyMap();

  // 1) productTypePath do fornecedor — o único eixo que é mesmo tipo de produto.
  //    categoria_principal resolve para franquias (Disney, Funko, Anime & Manga), por
  //    isso sozinha só cobria 6,2% do catálogo. Ver productTypeCategoryMap.js.
  const fromPath = Array.isArray(typeSource)
    ? categoryKeyFromSegments(typeSource)
    : categoryKeyFromProductTypePath(typeSource);
  if (fromPath) {
    const id = shopifyCategoryIds?.[fromPath];
    if (id && !id.startsWith("_")) {
      // Validação defensiva: garantir que o ID é válido antes de construir o GID
      if (!isValidCategoryId(id)) {
        console.warn(`[resolveShopifyCategoryGid] ID inválido: "${id}" para categoria "${fromPath}"`);
        return undefined;
      }
      return `gid://shopify/TaxonomyCategory/${id}`;
    }
  }

  // 2) Fallback: comportamento anterior, via productType derivado de categoryMain.
  if (!productType) return undefined;
  const id = shopifyCategoryIds?.[productType];
  if (!id || id.startsWith("_")) return undefined;

  // Validação defensiva: garantir que o ID é válido
  if (!isValidCategoryId(id)) {
    console.warn(`[resolveShopifyCategoryGid] ID inválido: "${id}" para productType "${productType}"`);
    return undefined;
  }
  return `gid://shopify/TaxonomyCategory/${id}`;
}

/**
 * Valida se um ID de categoria é válido (padrão: letras, números, hífen, ponto).
 * Previne GIDs malformados como "TaxonomyCategory/na" ou "TaxonomyCategory/undefined".
 * @param {string|undefined} id
 */
function isValidCategoryId(id) {
  if (typeof id !== "string" || !id.trim()) return false;
  // Padrão Shopify: alfanumérico, hífen e ponto (ex: "tg-5-8-1-1", "hg-3-30")
  return /^[a-zA-Z0-9\-\.]+$/.test(id) && id.length >= 2;
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
  const title = (product.title || `Product ${product.sku}`).replace(/[\r\n\t]/g, " ").trim();
  const vendor = product.vendor?.trim() || null;
  const categoryEn = resolveShopifyProductType(product.categoryMain);
  const cleanCategory = cleanUserFacingLabel(categoryEn);

  const rawFranchises = parseJsonArray(product.franchises);
  const cleanFranchises = Array.from(
    new Set(rawFranchises.map(cleanUserFacingLabel).filter(Boolean))
  );

  // Engaging English commercial intro
  let intro = `<p><strong>${escapeHtml(title)}</strong> is an official high-quality collectible item`;
  if (vendor) {
    intro += ` licensed by <strong>${escapeHtml(vendor)}</strong>`;
  }
  intro += `. Perfect for fans, collectors, and pop culture enthusiasts.</p>`;

  const specRows = [];

  // SKU / Reference
  specRows.push(`<tr>
    <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;width:35%;font-weight:600;color:#212529;">Reference / SKU</th>
    <td style="padding:10px 14px;border:1px solid #e9ecef;color:#495057;">${escapeHtml(product.sku)}</td>
  </tr>`);

  // Brand / Manufacturer
  if (vendor) {
    const brandUrl = `/collections/all?filter.p.vendor=${encodeURIComponent(vendor)}`;
    specRows.push(`<tr>
      <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">Brand / Manufacturer</th>
      <td style="padding:10px 14px;border:1px solid #e9ecef;"><a href="${brandUrl}" style="color:#005bd3;text-decoration:underline;font-weight:500;">${escapeHtml(vendor)}</a></td>
    </tr>`);
  }

  // Category / Type
  if (cleanCategory) {
    const catUrl = `/collections/all?filter.p.product_type=${encodeURIComponent(cleanCategory)}`;
    specRows.push(`<tr>
      <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">Category</th>
      <td style="padding:10px 14px;border:1px solid #e9ecef;"><a href="${catUrl}" style="color:#005bd3;text-decoration:underline;font-weight:500;">${escapeHtml(cleanCategory)}</a></td>
    </tr>`);
  }

  // License / Universe
  if (cleanFranchises.length > 0) {
    const franchiseLinks = cleanFranchises.map((f) => {
      const slug = toCollectionSlug(f);
      const url = slug ? `/collections/${slug}` : `/collections/all`;
      return `<a href="${url}" style="color:#005bd3;text-decoration:underline;font-weight:500;">${escapeHtml(f)}</a>`;
    }).join(", ");

    specRows.push(`<tr>
      <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">License / Universe</th>
      <td style="padding:10px 14px;border:1px solid #e9ecef;">${franchiseLinks}</td>
    </tr>`);
  }

  // EAN / Barcode
  if (product.barcode) {
    const cleanBarcode = String(product.barcode).trim();
    if (cleanBarcode) {
      specRows.push(`<tr>
        <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">EAN / Barcode</th>
        <td style="padding:10px 14px;border:1px solid #e9ecef;color:#495057;">${escapeHtml(cleanBarcode)}</td>
      </tr>`);
    }
  }

  // Peso — vem de xml_info_peso via weightKg (coluna CatalogProduct). Mostrado com até
  // 3 casas para não arredondar 0,611 kg para 0,6 kg, mas sem zeros à direita inúteis.
  const weightKg = Number(product.weightKg);
  if (Number.isFinite(weightKg) && weightKg > 0) {
    const weightLabel = `${parseFloat(weightKg.toFixed(3))} kg`;
    specRows.push(`<tr>
      <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">Weight</th>
      <td style="padding:10px 14px;border:1px solid #e9ecef;color:#495057;">${escapeHtml(weightLabel)}</td>
    </tr>`);
  }

  // Dimensões — a linha aparece sempre, mas o RÓTULO distingue a origem: medida real do
  // fornecedor (xml_info_dimensiones, ~69% do catálogo) vs. estimativa genérica nos ~31%
  // sem dados. Assim o cliente vê sempre uma referência de tamanho sem que a loja afirme
  // como facto uma medida que não conhece.
  const hasRealDimensions = Boolean(String(product.dimensions || "").trim());
  const dimensions = resolveShopifyDimensions(product);
  const dimensionsLabel = hasRealDimensions
    ? "Dimensions (W × H × D)"
    : "Approximate package size (W × H × D)";
  specRows.push(`<tr>
    <th style="text-align:left;padding:10px 14px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;color:#212529;">${escapeHtml(dimensionsLabel)}</th>
    <td style="padding:10px 14px;border:1px solid #e9ecef;color:#495057;">${escapeHtml(dimensions)}</td>
  </tr>`);

  const tableHtml = specRows.length > 0
    ? `<div style="margin-top:20px;">
        <h4 style="margin:0 0 10px 0;font-size:15px;font-weight:600;color:#212529;">Product Specifications</h4>
        <table style="width:100%;border-collapse:collapse;margin:0 0 16px 0;font-size:14px;border:1px solid #e9ecef;border-radius:8px;overflow:hidden;">
          <tbody>${specRows.join("")}</tbody>
        </table>
      </div>`
    : "";

  const guaranteeHtml = `<p style="font-size:13px;color:#6c757d;margin-top:16px;font-style:italic;">✓ 100% Official & Authentically Licensed Product. Fast shipping & secure packaging.</p>`;

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
export async function mapCatalogProductToShopifyPayload(product, opts = {}) {
  const franchises = parseJsonArray(product.franchises);
  const sku = String(product.sku || "").trim();
  const vendor = String(product.vendor || "").trim() || undefined;
  const barcode = resolveShopifyBarcode(product);
  const weightKg = resolveShopifyWeightKg(product);
  const tags = buildShopifyProductTags(vendor, franchises, opts.customTags || [], product);
  const productType = resolveShopifyProductType(product.categoryMain);
  // categorySegments traz os segmentos do productTypePath do fornecedor (ver csvFieldMap);
  // é daí que sai a categoria oficial, com categoryMain apenas como fallback.
  const shopifyCategoryGid = resolveShopifyCategoryGid(
    productType,
    product.productTypePath || parseJsonArray(product.categorySegments)
  );
  const retailPrice = computeShopifyRetailPrice(product.netPrice);
  const status = opts.status || "ACTIVE";
  const stock = Math.max(0, Math.floor(Number(product.stock ?? product.availableQuantity) || 0));

  const allImages = extractAllImageUrls(product);
  const cleanImgUrl = allImages[0] || null;
  const rawTitle = String(product.title || "").trim();
  let translatedTitle = rawTitle;
  // Quando o título veio pronto do fornecedor (titleSource === "supplier"), já está em
  // inglês final desde a indexação — passá-lo pela API aqui só o pode degradar, e é o
  // caminho que produzia sable→sailor, Rey→King e Solo→Alone. Linhas indexadas antes de
  // 2026-08-04 têm titleSource null e mantêm o comportamento anterior.
  if (rawTitle && product.titleSource !== "supplier") {
    try {
      translatedTitle = await translateTitleWithApiFallback({ title: rawTitle, vendor, franchises });
    } catch {
      translatedTitle = rawTitle;
    }
  }
  const title = (translatedTitle || rawTitle || `Product ${sku}`).replace(/[\r\n\t]/g, " ").trim();

  // Título já traduzido — garante que a descrição gerada não menciona o título
  // em espanhol/Spanglish enquanto o campo `title` do payload já vem em inglês.
  const descriptionHtml = buildProductDescriptionHtml({ ...product, vendor, sku, title });

  return {
    sku,
    title,
    vendor,
    barcode,
    weightKg,
    /** Licença primária (1.ª franchise), para o metafield ociostock.licence (item 5 — coleções automáticas). */
    franchises,
    /** Universo resolvido pelo franchiseResolver na indexação (Fase 4). Alimenta o
     *  metafield alterpop.franchise no publish (Fase 6b). NULL se não resolve, ou se a
     *  linha foi indexada antes da Fase 4 — nesse caso enche no próximo re-index. */
    resolvedFranchise: product.resolvedFranchise ?? null,
    /** dimensões formatadas — reais ou DEFAULT_PRODUCT_DIMENSIONS; alimenta ociostock.dimensions */
    dimensions: resolveShopifyDimensions(product),
    /** pauta aduaneira normalizada, ou null — vai em inventoryItem.harmonizedSystemCode */
    hsCode: product.hsCode || null,
    productType,
    category: shopifyCategoryGid,
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
        category: shopifyCategoryGid,
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
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
