import pLimit from "p-limit";
import { getDefaultConfig } from "./config.js";

let limiter = null;
let lastRequestAt = 0;

function getLimiter() {
  if (!limiter) {
    const { graphqlConcurrency } = getDefaultConfig().shopify;
    limiter = pLimit(graphqlConcurrency);
  }
  return limiter;
}

/**
 * Run a Shopify GraphQL request through concurrency + min-interval throttle.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runThrottled(fn) {
  const { graphqlMinMs } = getDefaultConfig().shopify;
  return getLimiter()(async () => {
    const now = Date.now();
    const wait = Math.max(0, graphqlMinMs - (now - lastRequestAt));
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
