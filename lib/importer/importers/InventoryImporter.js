import { config } from "../config.js";
import { BaseImporter } from "./BaseImporter.js";
import { resolveVariantBySku } from "../lib/resolveSku.js";
import { updateInventory } from "../shopifyClient.js";
import { ensureVariantInventoryPolicyDeny } from "../shopify/shopifyInventorySync.server.js";

export class InventoryImporter extends BaseImporter {
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

    const referenceUri = `ociostock://import/${this.job.jobId}`;
    const quantity = Math.max(0, Math.floor(Number(record.availableQuantity) || 0));

    await ensureVariantInventoryPolicyDeny(
      this.client,
      variant.product.id,
      variant.id
    );

    await updateInventory(this.client, {
      inventoryItemId: variant.inventoryItem.id,
      locationId,
      quantity,
      referenceDocumentUri: referenceUri,
    });

    this.job.recordSuccess({
      sku: record.sku,
      type: "inventory",
      action: "updated",
      quantity: record.availableQuantity,
      locationId,
    });
    this.job.metrics.inventoryUpdated++;
  }
}
