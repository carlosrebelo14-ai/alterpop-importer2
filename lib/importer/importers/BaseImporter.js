import { config } from "../config.js";

export class BaseImporter {
  constructor(job, client) {
    this.job = job;
    this.client = client;
    this.variantCache = new Map();
  }

  get dryRun() {
    return this.job.mode === "DRY_RUN";
  }

  async delayBetweenBatches() {
    if (config.import.batchDelayMs > 0) {
      await new Promise((r) => setTimeout(r, config.import.batchDelayMs));
    }
  }

  chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
