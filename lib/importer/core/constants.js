import { getDefaultConfig } from "../config.js";

/** Conservative default for OcioStock → Shopify row processing */
export const DEFAULT_STREAM_CONCURRENCY = 2;

/**
 * Row-level concurrency (p-limit). Env: STREAM_CONCURRENCY (falls back to SHOPIFY_GRAPHQL_CONCURRENCY).
 */
export function getStreamConcurrency() {
  const fromEnv = parseInt(process.env.STREAM_CONCURRENCY ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return getDefaultConfig().shopify.graphqlConcurrency || DEFAULT_STREAM_CONCURRENCY;
}

/**
 * Max SKUs to process (0 = unlimited). Env: SYNC_LIMIT.
 */
export function getSyncLimit(override = undefined) {
  if (override !== undefined && override !== null) {
    const n = parseInt(String(override), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return getDefaultConfig().import.syncLimit || 0;
}
