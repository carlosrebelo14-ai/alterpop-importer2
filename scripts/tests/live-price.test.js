#!/usr/bin/env node
/**
 * Briefing de integridade (09/10/2026), A3 — preço live nas linhas PUBLISHED.
 * compareLivePrice (puro) e loadLivePricesForPanel (cache e falha de leitura).
 * Uso: node scripts/tests/live-price.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { compareLivePrice } from "../../lib/importer/pricing/livePrice.js";
// O módulo arrasta o Prisma; sem base real, só precisa de um URL para não protestar.
process.env.DATABASE_URL ||= `file:${path.join(os.tmpdir(), "live-price-test-unused.sqlite")}`;
const { loadLivePricesForPanel, clearLivePriceCache } = await import("../../lib/importer/shopify/livePricePanel.server.js");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}

await check("Gandalf: live 14,90 vs regra 14,50 → differs, lucro sobre o live", () => {
  const r = compareLivePrice({ queueStatus: "PUBLISHED", finalPrice: 14.5, cost: 12.09, live: { price: 14.9 } });
  assert.equal(r.liveState, "differs");
  assert.equal(r.livePrice, 14.9);
  assert.equal(r.liveProfit, 2.81);
});
await check("live igual à regra ao cêntimo → ok", () => {
  assert.equal(compareLivePrice({ queueStatus: "PUBLISHED", finalPrice: 14.9, cost: 12.09, live: { price: "14.90" } }).liveState, "ok");
});
await check("linha que não é PUBLISHED não se compara", () => {
  for (const queueStatus of ["PENDING", "APPROVED", "REJECTED", undefined]) {
    const r = compareLivePrice({ queueStatus, finalPrice: 14.5, cost: 12.09, live: { price: 14.9 } });
    assert.equal(r.liveState, null);
    assert.equal(r.livePrice, null);
  }
});
await check("leitura falhada → unread com a causa, nunca ok", () => {
  const r = compareLivePrice({ queueStatus: "PUBLISHED", finalPrice: 14.5, cost: 12.09, live: null, readError: "boom" });
  assert.equal(r.liveState, "unread");
  assert.equal(r.liveError, "boom");
});
await check("PUBLISHED sem variante live → missing", () => {
  assert.equal(compareLivePrice({ queueStatus: "PUBLISHED", finalPrice: 14.5, cost: 12.09, live: null }).liveState, "missing");
});
await check("PUBLISHED com live mas sem preço calculado → no_rule", () => {
  assert.equal(compareLivePrice({ queueStatus: "PUBLISHED", finalPrice: null, cost: null, live: { price: 14.9 } }).liveState, "no_rule");
});

await check("loadLivePricesForPanel: uma leitura em lote e cache dentro do TTL", async () => {
  clearLivePriceCache();
  let calls = 0;
  const fetchLive = async (skus) => {
    calls += 1;
    return new Map(skus.map((s) => [s, { price: 14.9 }]));
  };
  const a = await loadLivePricesForPanel("s", ["A", "B"], { fetchLive, now: 1000 });
  assert.equal(calls, 1);
  assert.equal(a.bySku.get("A").price, 14.9);
  await loadLivePricesForPanel("s", ["A", "B"], { fetchLive, now: 2000 });
  assert.equal(calls, 1, "dentro do TTL não volta à Shopify");
  await loadLivePricesForPanel("s", ["A"], { fetchLive, now: 1000 + 61_000 });
  assert.equal(calls, 2, "depois do TTL volta a ler");
});
await check("loadLivePricesForPanel: falha devolve error, não lança, e não fica em cache", async () => {
  clearLivePriceCache();
  const r = await loadLivePricesForPanel("s", ["X"], { fetchLive: async () => { throw new Error("timeout"); }, now: 1 });
  assert.match(r.error, /timeout/);
  let calls = 0;
  await loadLivePricesForPanel("s", ["X"], { fetchLive: async (k) => { calls += 1; return new Map(k.map((s) => [s, null])); }, now: 2 });
  assert.equal(calls, 1);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
