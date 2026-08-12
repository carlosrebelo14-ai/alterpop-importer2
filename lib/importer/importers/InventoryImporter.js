import { config } from "../config.js";
import { BaseImporter } from "./BaseImporter.js";
import { resolveVariantBySku } from "../lib/resolveSku.js";
import { syncCatalogStockToShopify } from "../shopify/shopifyInventorySync.server.js";

export class InventoryImporter extends BaseImporter {
  /**
   * @param {import('../jobs/ImportJob.js').ImportJob} job
   * @param {object} client
   * @param {object} [settings]
   */
  constructor(job, client, settings = {}) {
    super(job, client);
    this.settings = settings;
  }

  /**
   * @param {import('../types.js').ProductRecord[]} records
   */
  async run(records) {
    for (const record of records) {
      try {
        await this.syncOne(record);
      } catch (err) {
        this.job.recordFailed({
          sku: record.sku,
          type: "inventory",
          reason: err?.message || String(err),
        });
      }
    }
  }

  /**
   * Sync inventory for a single SKU (used by stream importer).
   * @param {import('../types.js').ProductRecord} record
   */
  async syncOne(record) {
    const locationId = this.locationId || config.import.locationId;
    if (!locationId && !this.dryRun) {
      throw new Error("Inventory location ID is required");
    }

    if (this.dryRun) {
      this.job.recordSuccess({
        sku: record.sku,
        type: "inventory",
        action: "dry_run",
        quantity: record.availableQuantity,
      });
      this.job.metrics.inventoryUpdated++;
      return;
    }

    const variant = await resolveVariantBySku(this.client, record.sku, this.variantCache);
    if (!variant?.inventoryItem?.id) {
      throw new Error(
        "SKU not found or missing inventory item — run product import first"
      );
    }

    // syncCatalogStockToShopify() já trata a política DENY e o buffer de segurança
    // (this.settings.stockBuffer) — antes esta função chamava updateInventory()
    // diretamente e ignorava o buffer configurado em Definições (bug encontrado no
    // code review, 2026-08-12).
    const { quantity } = await syncCatalogStockToShopify(this.client, {
      productId: variant.product.id,
      variantId: variant.id,
      inventoryItemId: variant.inventoryItem.id,
      stock: record.availableQuantity,
      locationId,
      stockBuffer: this.settings.stockBuffer,
    });

    this.job.recordSuccess({
      sku: record.sku,
      type: "inventory",
      action: "updated",
      quantity,
      locationId,
    });
    this.job.metrics.inventoryUpdated++;
  }
}
