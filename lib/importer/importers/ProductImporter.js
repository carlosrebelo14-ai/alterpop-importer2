import { config } from "../config.js";
import { mapOcioStockRow } from "../connectors/ociostock/csvFieldMap.js";
import { streamOcioStockRows } from "../connectors/ociostock/streamCsv.js";
import { normalizeRecordCategories } from "../transform/normalizeCategory.js";
import { evaluateSmartRules } from "../curation/smartRules.server.js";
import { evaluateEliteCuration } from "../curation/eliteCuration.server.js";
import { resolveProductStatus } from "../curation/index.js";
import { upsertCurationQueueFromRecord, getCurationQueueEntry } from "../../curation/curationQueue.server.js";
import { curateWithAI } from "../../../server/lib/curator.js";
import { BaseImporter } from "./BaseImporter.js";
import { resolveVariantBySku } from "../lib/resolveSku.js";
import { ensureOciostockMetafieldDefinitions } from "../shopify/metafieldSetup.js";
import { isProductSyncLocked } from "../shopify/shopifyProductPublisher.server.js";
import { translateTitleFromGlossary } from "../transform/glossary/translateTitle.js";

function getChunkSize() {
  return config.import.batchSize || 20;
}

function getChunkPauseMs() {
  return config.import.batchDelayMs || 1000;
}

/** CSV url_imagen_principal → record.imageUrl (image_src) */
function isAbsoluteHttpUrl(url) {
  const trimmed = String(url || "").trim();
  return /^https?:\/\//i.test(trimmed);
}

/**
 * ProductVariantsBulkInput (API 2025-10): SKU em inventoryItem, não no root.
 * @param {import('../types.js').ProductRecord} record
 * @param {string} variantId
 * @param {{ syncPrices?: boolean }} [opts]
 */
function buildVariantBulkInput(record, variantId, opts = {}) {
  const input = { id: variantId };

  if (record.barcode || record.sku) {
    input.barcode = record.barcode || record.sku;
  }

  input.inventoryPolicy = "DENY";

  if (record.sku) {
    input.inventoryItem = {
      sku: record.sku,
      tracked: true,
    };
  }

  const syncPrices = opts.syncPrices !== false;
  if (syncPrices) {
    const price =
      record.grossPrice != null && record.grossPrice > 0
        ? record.grossPrice
        : record.netPrice;
    if (price != null && price > 0) {
      input.price = String(price.toFixed(2));
    }
  }

  return input;
}

const PRODUCT_UPDATE = `
  mutation ProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title }
      userErrors { field message }
    }
  }
`;

const PRODUCT_CREATE = `
  mutation ProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        title
        variants(first: 1) {
          nodes { id sku inventoryItem { id } }
        }
      }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_UPDATE = `
  mutation VariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

const PRODUCT_CREATE_MEDIA = `
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id }
      mediaUserErrors { field message }
    }
  }
`;

const METAFIELDS_SET = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

export class ProductImporter extends BaseImporter {
  /**
   * @param {import('../jobs/ImportJob.js').ImportJob} job
   * @param {object} client
   * @param {object} [settings]
   */
  constructor(job, client, settings = {}) {
    super(job, client);
    this.settings = settings;
    this.syncImages = settings.syncImages !== false;
    this.syncPrices = settings.syncPrices !== false;
    this.metafieldReady = false;
  }

  get importMode() {
    return this.settings.importMode || config.import.importMode;
  }

  get allowCreate() {
    return this.importMode === "CREATE_AND_UPDATE";
  }

  async prepare() {
    if (!this.dryRun && this.syncPrices) {
      this.metafieldReady = await ensureOciostockMetafieldDefinitions(this.client, this.job);
    }
  }

  /**
   * Terminal log before each GraphQL mutation (or dry-run simulation).
   * @param {import('../types.js').ProductRecord} record
   * @param {string} [mutationName]
   */
  logSync(record, mutationName) {
    const sku = record.sku || "(unknown)";
    const brand = record.vendor || "—";
    const categoryEn = record.categoryMain || record.category || "—";
    const categoryEs =
      record._source?.category ||
      record._translated?.categoryMain ||
      record._translated?.category ||
      null;

    let line = `[SYNC] Processando SKU: ${sku} | Marca: ${brand}`;
    if (categoryEs && categoryEs !== categoryEn) {
      line += ` | Categoria: ${categoryEn} (ES: ${categoryEs})`;
    } else {
      line += ` | Categoria: ${categoryEn}`;
    }
    if (record._shopifyStatus) {
      line += ` | Status: ${record._shopifyStatus}`;
      if (record._curationReasons?.length) {
        line += ` | Curadoria: ${record._curationReasons.join(", ")}`;
      }
    }
    if (mutationName) {
      line += ` | Mutation: ${mutationName}${this.dryRun ? " [DRY_RUN]" : ""}`;
    }
    console.log(line);
  }

  /**
   * Gatekeeper de curadoria — define ACTIVE/DRAFT antes das mutations GraphQL.
   * @param {import('../types.js').ProductRecord} record
   * @param {string} productType
   */
  async applyCuration(record, productType) {
    const { status, reasons } = await resolveProductStatus(record);
    record._shopifyStatus = status;
    record._curationReasons = reasons;

    if (status === "DRAFT") {
      this.job.recordCuratedDraft({
        sku: record.sku,
        vendor: record.vendor,
        category: productType,
        categoryEs: record._source?.category,
        franchises: record.franchises || [],
        reasons,
        status,
        title: record.title,
      });
    } else {
      this.job.recordProductActive();
      this.job.tallyCurationReasons(reasons);
    }

    return status;
  }

  /**
   * Never calls Shopify when DRY_RUN=true.
   * @param {string} mutationName
   * @param {import('../types.js').ProductRecord} record
   * @param {string} query
   * @param {object} variables
   */
  async executeGraphql(mutationName, record, query, variables) {
    this.logSync(record, mutationName);
    if (this.dryRun) {
      return {};
    }
    return this.client.graphql(query, variables);
  }

  /**
   * Importação por stream (fs.createReadStream + readline via streamOcioStockRows).
   * Não carrega o CSV inteiro em RAM — preferir isto a run(records).
   *
   * @param {object} [options]
   * @param {() => boolean} [options.shouldStop]
   * @param {(info: { processed: number, sku: string }) => void | Promise<void>} [options.onProgress]
   */
  async runFromCsvStream(options = {}) {
    await this.prepare();

    let processed = 0;
    let chunkIndex = 0;
    let rowsInChunk = 0;

    await streamOcioStockRows({
      shouldStop: options.shouldStop,
      onRow: async (rawRow) => {
        const record = mapOcioStockRow(rawRow);
        if (!record?.sku) return;

        try {
          await this.upsertOne(record);
        } catch (err) {
          this.job.recordFailed(this.buildFailureEntry(record, err, "product"));
        }

        processed += 1;
        rowsInChunk += 1;
        if (options.onProgress) {
          await options.onProgress({ processed, sku: record.sku });
        }

        if (rowsInChunk >= getChunkSize()) {
          rowsInChunk = 0;
          chunkIndex += 1;
          this.job.recordBatchComplete?.();
          if (options.shouldStop?.()) return;
          await new Promise((resolve) => setTimeout(resolve, getChunkPauseMs()));
        }
      },
    });

    if (this.client?.stats) {
      this.job.mergeClientStats(this.client.stats);
    }

    return { processed };
  }

  /**
   * Apenas para lotes pequenos (allowlist). Para catálogo completo use runFromCsvStream.
   * @param {import('../types.js').ProductRecord[]} records
   */
  async run(records) {
    if (records.length > 500) {
      console.warn(
        `[ProductImporter] run() com ${records.length} registos em RAM — preferir runFromCsvStream()`
      );
    }

    await this.prepare();

    const chunks = this.chunk(records, getChunkSize());

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const batch = chunks[chunkIndex];
      let batchHadFatal = false;

      try {
        for (const record of batch) {
          try {
            await this.upsertOne(record);
          } catch (err) {
            this.job.recordFailed(this.buildFailureEntry(record, err, "product"));
          }
        }
      } catch (err) {
        batchHadFatal = true;
        this.job.recordFailedBatch?.(
          chunkIndex,
          batch.map((r) => r.sku).filter(Boolean),
          err?.message || String(err)
        );
      }

      if (!batchHadFatal) {
        this.job.recordBatchComplete?.();
      }

      if (chunkIndex < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, getChunkPauseMs()));
      }
    }

    if (this.client?.stats) {
      this.job.mergeClientStats(this.client.stats);
    }
  }

  /**
   * @param {import('../types.js').ProductRecord} record
   * @param {Error} err
   * @param {string} type
   */
  buildFailureEntry(record, err, type) {
    const reason = err?.message || String(err);
    return {
      sku: record?.sku,
      type,
      reason,
      stack: err?.stack,
      title: record?.title,
      vendor: record?.vendor,
      category: record?.category,
      grossPrice: record?.grossPrice,
      netPrice: record?.netPrice,
      availableQuantity: record?.availableQuantity,
    };
  }

  /**
   * When CSV provides image_src (url_imagen_principal → imageUrl), require absolute http(s) URL.
   * @param {import('../types.js').ProductRecord} record
   * @returns {{ field: string, url: string }[]}
   */
  sanitizeImageUrls(record) {
    const invalid = [];

    if (record.imageUrl?.trim()) {
      if (!isAbsoluteHttpUrl(record.imageUrl)) {
        invalid.push({ field: "imageUrl", url: record.imageUrl.trim() });
        record.imageUrl = undefined;
      }
    }

    if (record.imageUrlLarge?.trim()) {
      if (!isAbsoluteHttpUrl(record.imageUrlLarge)) {
        invalid.push({ field: "imageUrlLarge", url: record.imageUrlLarge.trim() });
        record.imageUrlLarge = undefined;
      }
    }

    if (Array.isArray(record.extraImages) && record.extraImages.length > 0) {
      const kept = [];
      record.extraImages.forEach((url, index) => {
        if (!url?.trim()) return;
        if (!isAbsoluteHttpUrl(url)) {
          invalid.push({ field: `extraImages[${index}]`, url: url.trim() });
          return;
        }
        kept.push(url.trim());
      });
      record.extraImages = kept.length > 0 ? kept : undefined;
    }

    return invalid;
  }

  /**
   * @param {import('../types.js').ProductRecord} record
   * @param {string} productType
   */
  async simulateDryRunUpsert(record, productType) {
    const mutation =
      this.allowCreate ? "productCreate" : "productUpdate";
    await this.executeGraphql(mutation, record, PRODUCT_CREATE, { product: {} });

    if (this.syncPrices) {
      await this.executeGraphql(
        "productVariantsBulkUpdate",
        record,
        VARIANTS_BULK_UPDATE,
        { productId: "gid://shopify/Product/0", variants: [] }
      );
      await this.executeGraphql("metafieldsSet", record, METAFIELDS_SET, { metafields: [] });
    }

    if (this.syncImages && record.imageUrl) {
      await this.executeGraphql("productCreateMedia", record, PRODUCT_CREATE_MEDIA, {
        productId: "gid://shopify/Product/0",
        media: [],
      });
    }

    this.job.recordSuccess({
      sku: record.sku,
      type: "product",
      action: this.allowCreate ? "dry_run_upsert" : "dry_run_update",
      title: record.title,
      titleEs: record._source?.title,
      vendor: record.vendor,
      category: productType,
      categoryEs: record._source?.category,
      grossPrice: record.grossPrice,
      netPrice: record.netPrice,
      stock: record.availableQuantity,
      importMode: this.importMode,
      wouldAttachImage: Boolean(this.syncImages && record.imageUrl),
      shopifyStatus: record._shopifyStatus,
      curationReasons: record._curationReasons,
    });
    this.job.metrics.productsUpdated++;
  }

  applyTitleGlossary(record) {
    if (this.settings.autoGlossaryTranslation === false) return;
    if (!record.title?.trim()) return;
    const en = translateTitleFromGlossary(record.title);
    if (en !== record.title) {
      record._translated = record._translated || {};
      record._translated.title = en;
      record.title = en;
    }
  }

  async upsertOne(record) {
    normalizeRecordCategories(record, {
      sku: record.sku,
      jobId: this.job?.jobId,
    });

    let productType = record.categoryMain || record.category;

    this.applyTitleGlossary(record);

    // Overrides manuais do CSV re-import (item 9) e do metafield ociostock.sync_locked
    // (item 15) só eram respeitados no caminho shopifyProductPublisher.server.js
    // (Curadoria -> Aprovar -> sync); esta importadora (página Import) tinha os dois
    // completamente ignorados (bug encontrado no code review, 2026-08-12).
    const queueEntry = await getCurationQueueEntry(record.sku);
    const overrides = queueEntry?.metadata?.overrides;
    if (overrides?.title) record.title = overrides.title;
    if (overrides?.category) productType = overrides.category;
    if (overrides?.price != null && Number.isFinite(Number(overrides.price)) && Number(overrides.price) > 0) {
      record.grossPrice = Number(overrides.price);
    }

    record._aiCuration = await curateWithAI(record.title || record.sku || "");

    await upsertCurationQueueFromRecord(record);

    const elite = evaluateEliteCuration(record);
    if (elite.action === "AUTO_REJECT") {
      record._smartRejected = true;
      record._smartAction = "AUTO_REJECT";
      record._eliteAction = "AUTO_REJECT";
    } else if (elite.action === "PENDING_MANUAL") {
      record._eliteAction = "PENDING_MANUAL";
    } else {
      const smart = evaluateSmartRules(record, { jobId: this.job?.jobId });
      if (smart.action === "AUTO_APPROVE") {
        record._smartApproved = true;
        record._smartAction = "AUTO_APPROVE";
      } else if (smart.action === "AUTO_REJECT") {
        record._smartRejected = true;
        record._smartAction = "AUTO_REJECT";
      }
    }

    await this.applyCuration(record, productType);

    const invalidImages = this.sanitizeImageUrls(record);
    for (const { field, url } of invalidImages) {
      this.job.recordFailed({
        sku: record.sku,
        type: "media",
        reason: "invalid_image_url",
        field,
        imageUrl: url,
        title: record.title,
      });
    }

    if (this.dryRun) {
      await this.simulateDryRunUpsert(record, productType);
      return;
    }

    const variant = await resolveVariantBySku(this.client, record.sku, this.variantCache);
    if (variant) {
      await this.updateProduct(record, variant, productType);
    } else if (this.allowCreate) {
      await this.createProduct(record, productType);
    } else {
      this.job.recordFailed({
        sku: record.sku,
        type: "product",
        reason: "SKU not found in Shopify (UPDATE_ONLY)",
        title: record.title,
      });
    }
  }

  async updateProduct(record, variant, productType) {
    const locked = !this.dryRun && (await isProductSyncLocked(this.client, variant.product.id));
    if (locked) {
      console.log(`[ProductImporter] ${record.sku} bloqueado (ociostock.sync_locked=true) — título/preço/categoria não tocados`);
    }

    if (!locked) {
      const input = {
        id: variant.product.id,
        title: record.title || undefined,
        vendor: record.vendor || undefined,
        productType: productType || undefined,
        status: record._shopifyStatus || "ACTIVE",
        tags: productType ? [productType] : undefined,
      };

      if (record.description) {
        input.descriptionHtml = `<p>${escapeHtml(record.description)}</p>`;
      }

      const data = await this.executeGraphql("productUpdate", record, PRODUCT_UPDATE, { input });
      const errors = data.productUpdate?.userErrors || [];
      if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));

      await this.updateVariantPricing(record, variant);
      if (this.syncImages) await this.attachImages(variant.product.id, record);
    }

    await this.setNetPriceMetafield(variant.product.id, record);

    this.job.recordSuccess({
      sku: record.sku,
      type: "product",
      action: "updated",
      productId: variant.product.id,
      shopifyStatus: record._shopifyStatus,
      curationReasons: record._curationReasons,
      syncLocked: locked,
    });
    this.job.metrics.productsUpdated++;
  }

  async createProduct(record, productType) {
    const product = {
      title: record.title || `Product ${record.sku}`,
      vendor: record.vendor || undefined,
      productType: productType || undefined,
      status: record._shopifyStatus || "ACTIVE",
      tags: productType ? [productType] : undefined,
    };

    if (record.description) {
      product.descriptionHtml = `<p>${escapeHtml(record.description)}</p>`;
    }

    const data = await this.executeGraphql("productCreate", record, PRODUCT_CREATE, { product });
    const errors = data.productCreate?.userErrors || [];
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));

    const created = data.productCreate.product;
    const variantNode = created.variants?.nodes?.[0];
    if (!variantNode?.id) throw new Error("Product created but no default variant returned");

    const variantInput = buildVariantBulkInput(record, variantNode.id, {
      syncPrices: this.syncPrices,
    });

    const bulkData = await this.executeGraphql(
      "productVariantsBulkUpdate",
      record,
      VARIANTS_BULK_UPDATE,
      { productId: created.id, variants: [variantInput] }
    );
    const bulkErrors = bulkData.productVariantsBulkUpdate?.userErrors || [];
    if (bulkErrors.length) throw new Error(bulkErrors.map((e) => e.message).join("; "));

    const updatedVariant = bulkData.productVariantsBulkUpdate.productVariants?.[0];
    const inventoryItemId = updatedVariant?.inventoryItem?.id || variantNode.inventoryItem?.id;

    this.variantCache.set(record.sku, {
      id: variantNode.id,
      sku: record.sku,
      product: { id: created.id, title: created.title },
      inventoryItem: inventoryItemId ? { id: inventoryItemId } : null,
    });

    await this.setNetPriceMetafield(created.id, record);
    if (this.syncImages) await this.attachImages(created.id, record);

    this.job.recordSuccess({
      sku: record.sku,
      type: "product",
      action: "created",
      productId: created.id,
      variantId: variantNode.id,
      shopifyStatus: record._shopifyStatus,
      curationReasons: record._curationReasons,
    });
    this.job.metrics.productsCreated++;
  }

  async updateVariantPricing(record, variant) {
    if (!this.syncPrices) return;
    const price =
      record.grossPrice != null && record.grossPrice > 0
        ? record.grossPrice
        : record.netPrice;
    if (price == null || price <= 0) return;

    const bulkData = await this.executeGraphql(
      "productVariantsBulkUpdate",
      record,
      VARIANTS_BULK_UPDATE,
      {
        productId: variant.product.id,
        variants: [
          buildVariantBulkInput(record, variant.id, { syncPrices: true }),
        ],
      }
    );
    const bulkErrors = bulkData.productVariantsBulkUpdate?.userErrors || [];
    if (bulkErrors.length) throw new Error(bulkErrors.map((e) => e.message).join("; "));
    this.job.metrics.pricesUpdated = (this.job.metrics.pricesUpdated || 0) + 1;
  }

  async setNetPriceMetafield(productId, record) {
    if (!this.syncPrices || record.netPrice == null) return;
    if (!this.metafieldReady) return;

    const data = await this.executeGraphql("metafieldsSet", record, METAFIELDS_SET, {
      metafields: [
        {
          ownerId: productId,
          namespace: "ociostock",
          key: "net_price",
          type: "number_decimal",
          value: String(record.netPrice.toFixed(2)),
        },
      ],
    });
    const errors = data.metafieldsSet?.userErrors || [];
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  }

  async attachImages(productId, record) {
    const urls = [
      record.imageUrl,
      record.imageUrlLarge,
      ...(record.extraImages || []),
    ].filter(Boolean);
    const unique = [...new Set(urls)];
    if (unique.length === 0) return;

    const media = unique.map((url) => ({
      originalSource: url,
      mediaContentType: "IMAGE",
    }));

    try {
      const data = await this.executeGraphql(
        "productCreateMedia",
        record,
        PRODUCT_CREATE_MEDIA,
        { productId, media }
      );
      const errors = data.productCreateMedia?.mediaUserErrors || [];
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join("; "));
      }
      this.job.metrics.imagesAttached = (this.job.metrics.imagesAttached || 0) + unique.length;
    } catch (err) {
      this.job.recordFailed(this.buildFailureEntry(record, err, "media"));
    }
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
