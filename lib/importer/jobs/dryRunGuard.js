import { getDefaultConfig } from "../config.js";

/**
 * Block live imports when DRY_RUN=true in environment.
 * @param {boolean} dryRun
 */
export function assertLiveImportAllowed(dryRun) {
  if (dryRun) return;
  if (getDefaultConfig().import.dryRun) {
    throw new Error(
      "Live import blocked: DRY_RUN=true in environment. Set DRY_RUN=false in .env for production imports."
    );
  }
}
