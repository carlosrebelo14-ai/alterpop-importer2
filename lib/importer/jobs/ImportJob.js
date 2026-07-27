import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { flushMissingGlossaryLog } from "../transform/glossary/index.js";
import {
  logExecution,
  mapSuccessToExecutionAction,
} from "../logging/executionHistory.js";

export class ImportJob {
  constructor({
    jobId,
    dryRun = false,
    source = "ociostock",
    importMode = "UPDATE_ONLY",
    shop = "",
  } = {}) {
    const paths = getDefaultConfig().paths;
    this.jobId = jobId || formatJobId(new Date());
    this.shop = shop;
    this.source = source;
    this.mode = dryRun ? "DRY_RUN" : "live";
    this.importMode = importMode;
    this.status = "preview";
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.metrics = {
      totalRows: 0,
      streamRowsRead: 0,
      productsCreated: 0,
      productsUpdated: 0,
      inventoryUpdated: 0,
      imagesAttached: 0,
      pricesUpdated: 0,
      failed: 0,
      skipped: 0,
      validationSkipped: 0,
      rateLimitRetries: 0,
      curatedDrafts: 0,
      productsActive: 0,
      curationByReason: {},
      batchesCompleted: 0,
      batchesFailed: 0,
      batchesPendingRetry: 0,
    };
    /** @type {{ batchIndex: number, skus: string[], error: string }[]} */
    this.failedBatches = [];
    this.success = [];
    this.failed = [];
    this.skipped = [];
    this.validationSkippedLog = [];
    this.curatedDrafts = [];
    this.resultsDir = path.join(paths.results, this.jobId);
  }

  recordSuccess(entry) {
    this.success.push(entry);
    if (this.shop && entry.sku) {
      import("../sync/syncErrorLog.server.js")
        .then(({ clearSyncErrorForSku }) => clearSyncErrorForSku(this.shop, entry.sku))
        .catch(() => {});
    }
    if (entry.shopifyStatus === "DRAFT") return;
    const action = mapSuccessToExecutionAction(entry);
    const reasons = entry.curationReasons || [];
    logExecution({
      sku: entry.sku || "(unknown)",
      action,
      reason: reasons.length ? reasons : entry.shopifyStatus === "ACTIVE" ? "approved" : "-",
      jobId: this.jobId,
    }).catch(() => {});
  }

  recordFailed(entry) {
    const row = {
      ...entry,
      loggedAt: new Date().toISOString(),
    };
    this.failed.push(row);
    this.metrics.failed++;
    logExecution({
      sku: entry.sku || "(unknown)",
      action: "rejeitado",
      reason: entry.reason || entry.type || "failed",
      jobId: this.jobId,
    }).catch(() => {});

    if (this.shop && entry.sku) {
      import("../sync/syncErrorLog.server.js")
        .then(({ persistSyncError }) =>
          persistSyncError({
            shop: this.shop,
            sku: entry.sku,
            reason: entry.reason || entry.type || "failed",
            type: entry.type,
            jobId: this.jobId,
          })
        )
        .catch(() => {});
    }

    return row;
  }

  recordFailedBatch(batchIndex, skus, error) {
    this.failedBatches.push({
      batchIndex,
      skus: [...skus],
      error: String(error || "batch_failed"),
    });
    this.metrics.batchesFailed += 1;
    this.metrics.batchesPendingRetry += 1;
  }

  recordBatchComplete() {
    this.metrics.batchesCompleted += 1;
  }

  async ensureResultsDir() {
    await fs.mkdir(this.resultsDir, { recursive: true });
  }

  async logMetafieldCheck(payload) {
    await fs.mkdir(this.resultsDir, { recursive: true });
    const file = path.join(this.resultsDir, "metafield-check.json");
    await fs.writeFile(
      file,
      JSON.stringify({ ...payload, checkedAt: new Date().toISOString() }, null, 2)
    );
  }

  recordSkipped(entry) {
    this.skipped.push(entry);
    this.metrics.skipped++;
  }

  recordValidationSkipped({ sku, errors }) {
    const entry = { sku, type: "validation", errors, reason: errors.join("; ") };
    this.validationSkippedLog.push(entry);
    this.skipped.push(entry);
    this.metrics.validationSkipped++;
    this.metrics.skipped++;
    logExecution({
      sku,
      action: "rejeitado",
      reason: `validation: ${errors.join("; ")}`,
      jobId: this.jobId,
    }).catch(() => {});
  }

  /**
   * Produto forçado a DRAFT pelas regras de curadoria (auditoria).
   * @param {object} entry
   */
  recordCuratedDraft(entry) {
    const row = {
      ...entry,
      loggedAt: new Date().toISOString(),
    };
    this.curatedDrafts.push(row);
    this.metrics.curatedDrafts++;
    this.#bumpCurationReasons(entry.reasons);
    const reasons = entry.reasons || entry.curationReasons || [];
    logExecution({
      sku: entry.sku || "(unknown)",
      action: "rejeitado",
      reason: reasons.length ? reasons.join(", ") : "curated_draft",
      jobId: this.jobId,
    }).catch(() => {});
  }

  recordProductActive() {
    this.metrics.productsActive++;
  }

  /**
   * Contabiliza motivos de curadoria (ACTIVE e DRAFT) para relatório/UI.
   * @param {string[]} [reasons]
   */
  tallyCurationReasons(reasons) {
    this.#bumpCurationReasons(reasons);
  }

  #bumpCurationReasons(reasons) {
    for (const reason of reasons || []) {
      if (!reason) continue;
      this.metrics.curationByReason[reason] =
        (this.metrics.curationByReason[reason] || 0) + 1;
    }
  }

  buildCurationReport() {
    return {
      jobId: this.jobId,
      mode: this.mode,
      updatedAt: new Date().toISOString(),
      totals: {
        active: this.metrics.productsActive,
        draft: this.metrics.curatedDrafts,
        productsCreated: this.metrics.productsCreated,
        productsUpdated: this.metrics.productsUpdated,
      },
      byReason: { ...this.metrics.curationByReason },
      draftEntries: this.curatedDrafts.length,
    };
  }

  mergeClientStats(clientStats = {}) {
    if (clientStats.rateLimitRetries) {
      this.metrics.rateLimitRetries += clientStats.rateLimitRetries;
    }
  }

  async finalize(status = "completed") {
    this.status = status;
    this.finishedAt = new Date().toISOString();
    await fs.mkdir(this.resultsDir, { recursive: true });

    const summary = {
      jobId: this.jobId,
      source: this.source,
      mode: this.mode,
      importMode: this.importMode,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      metrics: this.metrics,
    };

    await flushMissingGlossaryLog(this).catch(() => {});

    await Promise.all([
      fs.writeFile(path.join(this.resultsDir, "summary.json"), JSON.stringify(summary, null, 2)),
      fs.writeFile(path.join(this.resultsDir, "success.json"), JSON.stringify(this.success, null, 2)),
      fs.writeFile(path.join(this.resultsDir, "failed.json"), JSON.stringify(this.failed, null, 2)),
      fs.writeFile(path.join(this.resultsDir, "skipped.json"), JSON.stringify(this.skipped, null, 2)),
      fs.writeFile(
        path.join(this.resultsDir, "validation-skipped.json"),
        JSON.stringify(this.validationSkippedLog, null, 2)
      ),
      fs.writeFile(
        path.join(this.resultsDir, "curated-drafts.json"),
        JSON.stringify(
          {
            jobId: this.jobId,
            updatedAt: new Date().toISOString(),
            totalDrafts: this.curatedDrafts.length,
            entries: this.curatedDrafts,
          },
          null,
          2
        )
      ),
      fs.writeFile(
        path.join(this.resultsDir, "curation-summary.json"),
        JSON.stringify(this.buildCurationReport(), null, 2)
      ),
      this.failedBatches.length
        ? fs.writeFile(
            path.join(this.resultsDir, "failed-batches.json"),
            JSON.stringify(
              {
                jobId: this.jobId,
                batches: this.failedBatches,
                retrySkus: [...new Set(this.failedBatches.flatMap((b) => b.skus))],
              },
              null,
              2
            )
          )
        : Promise.resolve(),
    ]);

    return summary;
  }
}

function formatJobId(date) {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
