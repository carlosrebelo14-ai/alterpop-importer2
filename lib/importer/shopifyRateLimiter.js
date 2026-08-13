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
    // Fix (code review 2026-08-13): reservar o próximo slot ANTES do await — com
    // graphqlConcurrency > 1, vários callbacks concorrentes liam o mesmo
    // lastRequestAt antes de qualquer um o atualizar (só era escrito depois do
    // sleep), disparando em rajada em vez de espaçados. Escrever de forma síncrona,
    // sem await pelo meio, serializa a reserva mesmo com várias chamadas em voo.
    lastRequestAt = now + wait;
    if (wait > 0) await sleep(wait);
    return fn();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
