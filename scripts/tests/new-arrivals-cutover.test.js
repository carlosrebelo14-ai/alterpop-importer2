#!/usr/bin/env node
/**
 * Corte do N1 (briefing 27/09) — newArrivalsCutover.js (partes puras do
 * new-arrivals-cutover.js). Backfill, escolha da data, distribuição por dia, regra.
 * Uso: node scripts/tests/new-arrivals-cutover.test.js
 */
import assert from "node:assert/strict";
import {
  pickFirstPublishedAt,
  planNewArrivalsBackfill,
  distributionByDay,
  buildNewArrivalsRuleSet,
  applyNewArrivalsRuleWithRollback,
  toRuleSetInput,
  RULE_POLL_INTERVAL_MS,
  RULE_POLL_TIMEOUT_MS,
  DIVERGENCE_THRESHOLD_MS,
} from "../../lib/importer/shopify/newArrivalsCutover.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const NOW = new Date("2026-09-27T12:00:00Z");

check("pick — duas fontes: escolhe a mais antiga e reporta a diferença", () => {
  const r = pickFirstPublishedAt({ queuePublishedAt: "2026-09-12T10:00:00Z", shopifyPublishedAt: "2026-09-20T10:00:00Z" });
  assert.equal(r.value, "2026-09-12T10:00:00.000Z");
  assert.equal(r.source, "queue");
  assert.equal(r.divergenceMs, 8 * 24 * 60 * 60 * 1000);
});

check("pick — Shopify mais antiga que a fila (republicação pela app) → Shopify", () => {
  const r = pickFirstPublishedAt({ queuePublishedAt: "2026-09-25T10:00:00Z", shopifyPublishedAt: "2026-09-12T10:00:00Z" });
  assert.equal(r.source, "shopify");
});

check("pick — só Shopify (sem registo na fila) → recurso Shopify", () => {
  const r = pickFirstPublishedAt({ queuePublishedAt: null, shopifyPublishedAt: "2026-09-12T10:00:00Z" });
  assert.deepEqual(r, { value: "2026-09-12T10:00:00.000Z", source: "shopify", divergenceMs: null });
});

const p = (over) => ({
  productId: "gid://shopify/Product/1",
  handle: "h",
  sku: "S1",
  publishedAt: "2026-09-12T10:00:00Z",
  firstPublishedAt: null,
  isNewArrival: null,
  ...over,
});

check("backfill — ACTIVE publicado recebe first_published_at e is_new_arrival calculado", () => {
  const plan = planNewArrivalsBackfill([p()], new Map(), NOW);
  assert.deepEqual(plan.writes.map((w) => [w.key, w.value]), [
    ["first_published_at", "2026-09-12T10:00:00.000Z"],
    ["is_new_arrival", "true"],
  ]);
  assert.equal(plan.expectedTrue, 1);
});

check("backfill — já com first_published_at não é reescrito (idempotente)", () => {
  const plan = planNewArrivalsBackfill([p({ firstPublishedAt: "2026-09-01T00:00:00Z", isNewArrival: true })], new Map(), NOW);
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.alreadySet.length, 1);
  assert.equal(plan.expectedTrue, 1);
});

check("backfill — ACTIVE não publicado fica sem os dois campos", () => {
  const plan = planNewArrivalsBackfill([p({ publishedAt: null })], new Map(), NOW);
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.unpublished.length, 1);
});

check("backfill — divergência acima do limiar é reportada por SKU", () => {
  const q = new Map([["S1", "2026-09-10T10:00:00Z"]]);
  const plan = planNewArrivalsBackfill([p()], q, NOW);
  assert.equal(plan.divergences.length, 1);
  assert.equal(plan.divergences[0].chosen, "queue");
  assert.equal(plan.rows[0].backfillAt, "2026-09-10T10:00:00.000Z");
});

check("backfill — diferença de segundos entre fila e Shopify não é divergência", () => {
  const q = new Map([["S1", new Date(new Date("2026-09-12T10:00:00Z").getTime() + 30_000).toISOString()]]);
  assert.ok(30_000 < DIVERGENCE_THRESHOLD_MS);
  assert.equal(planNewArrivalsBackfill([p()], q, NOW).divergences.length, 0);
});

check("backfill — publicado há 45 dias entra com is_new_arrival=false", () => {
  const plan = planNewArrivalsBackfill([p({ publishedAt: "2026-08-13T10:00:00Z" })], new Map(), NOW);
  assert.equal(plan.writes.find((w) => w.key === "is_new_arrival").value, "false");
  assert.equal(plan.expectedTrue, 0);
});

check("backfill — processed conta todos os ACTIVE lidos", () => {
  const plan = planNewArrivalsBackfill(
    [p(), p({ productId: "2", sku: "S2", publishedAt: null }), p({ productId: "3", sku: "S3", firstPublishedAt: "2026-09-01T00:00:00Z" })],
    new Map(),
    NOW,
  );
  assert.equal(plan.processed, 3);
});

check("distribuição — por dia UTC, com o dia em que o lote sai (piloto 12/09 → 12/10)", () => {
  const d = distributionByDay([
    { backfillAt: "2026-09-12T08:00:00.000Z" },
    { backfillAt: "2026-09-12T20:00:00.000Z" },
    { backfillAt: "2026-09-16T09:00:00.000Z" },
  ]);
  assert.deepEqual(d, [
    { day: "2026-09-12", count: 2, expiresOn: "2026-10-12" },
    { day: "2026-09-16", count: 1, expiresOn: "2026-10-16" },
  ]);
});

check("regra — substitui a regra inteira por is_new_arrival EQUALS true, sem TAG", () => {
  const rs = buildNewArrivalsRuleSet("gid://shopify/MetafieldDefinition/9");
  assert.deepEqual(rs, {
    appliedDisjunctively: false,
    rules: [{ column: "PRODUCT_METAFIELD_DEFINITION", relation: "EQUALS", condition: "true", conditionObjectId: "gid://shopify/MetafieldDefinition/9" }],
  });
});

check("regra — recusa sem GID da definição", () => {
  assert.throws(() => buildNewArrivalsRuleSet(null), /falta o GID/);
});

// ── passo 3: reversão (decisão 27/09) ──

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const OLD_RULE = { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "new-arrival" }] };
const NEW_RULE = buildNewArrivalsRuleSet("gid://shopify/MetafieldDefinition/9");

/** Loja falsa: a contagem segue a sequência dada; a regra aplicada fica registada. */
function fakeCollection(counts) {
  const applied = [];
  let current = OLD_RULE;
  let i = 0;
  return {
    applied,
    sleeps: [],
    updateRule: async (rs) => {
      applied.push(rs);
      current = rs;
    },
    readCollection: async () => {
      const count = current === OLD_RULE || applied.at(-1)?.rules[0].column === "TAG" ? 160 : counts[Math.min(i++, counts.length - 1)];
      return { count, ruleSet: current };
    },
  };
}

const run = (shop, over = {}) =>
  applyNewArrivalsRuleWithRollback({
    updateRule: shop.updateRule,
    readCollection: shop.readCollection,
    previousRuleSet: OLD_RULE,
    newRuleSet: NEW_RULE,
    expected: 159,
    sleep: async (ms) => shop.sleeps.push(ms),
    ...over,
  });

await checkAsync("espera — 15 s entre leituras, até 5 min (20 leituras)", async () => {
  assert.equal(RULE_POLL_INTERVAL_MS, 15_000);
  assert.equal(RULE_POLL_TIMEOUT_MS, 300_000);
  const shop = fakeCollection([0]);
  const r = await run(shop);
  assert.equal(r.polls, 20);
  assert.ok(shop.sleeps.every((ms) => ms === 15_000));
});

await checkAsync("159 → sucesso, sai logo, não reverte", async () => {
  const shop = fakeCollection([0, 12, 159]);
  const r = await run(shop);
  assert.equal(r.outcome, "success");
  assert.equal(r.polls, 3);
  assert.equal(shop.applied.length, 1);
});

await checkAsync("0 no fim da espera → repõe TAG new-arrival e relê a regra reposta", async () => {
  const shop = fakeCollection([0]);
  const r = await run(shop);
  assert.equal(r.outcome, "rolled_back");
  assert.equal(shop.applied.length, 2);
  assert.deepEqual(shop.applied[1], OLD_RULE);
  assert.deepEqual(r.restoredRuleSet, OLD_RULE);
});

await checkAsync("0 transitório que chega a 159 dentro da espera → sucesso, sem reversão", async () => {
  const shop = fakeCollection([0, 0, 0, 0, 159]);
  const r = await run(shop);
  assert.equal(r.outcome, "success");
  assert.equal(shop.applied.length, 1);
});

await checkAsync("parcial (1 a 158) no fim da espera → não reverte, reporta", async () => {
  const shop = fakeCollection([80]);
  const r = await run(shop);
  assert.equal(r.outcome, "partial");
  assert.equal(r.count, 80);
  assert.equal(shop.applied.length, 1);
});

await checkAsync("toRuleSetInput — regra lida da loja volta a input só com column/relation/condition", async () => {
  const read = { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "new-arrival", conditionObject: { __typename: "X" } }] };
  assert.deepEqual(toRuleSetInput(read), OLD_RULE);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nnew-arrivals-cutover: todos os casos passaram");
