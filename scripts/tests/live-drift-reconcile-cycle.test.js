#!/usr/bin/env node
/**
 * Item 7 (ADENDA 7, briefing backend, 17/09/2026) — liveDriftReconcileCycle.server.js,
 * decideLiveDriftCycleAction (parte pura, sem Shopify/Prisma/fs).
 * Uso: node scripts/tests/live-drift-reconcile-cycle.test.js
 */
import assert from "node:assert/strict";
import {
  decideLiveDriftCycleAction,
  MAX_AUTO_RECONCILE,
} from "../../lib/importer/shopify/liveDriftReconcileCycle.server.js";

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

function product(sku, drifts) {
  return { sku, handle: `handle-${sku}`, productId: `gid://shopify/Product/${sku}`, drifts };
}

check("MAX_AUTO_RECONCILE é 10", () => {
  assert.equal(MAX_AUTO_RECONCILE, 10);
});

check("sem produtos com drift → green", () => {
  const decision = decideLiveDriftCycleAction([]);
  assert.equal(decision.status, "green");
  assert.deepEqual(decision.toWrite, []);
  assert.deepEqual(decision.blocked, []);
});

check("1 produto em drift, esperado não-nulo → yellow, entra em toWrite", () => {
  const decision = decideLiveDriftCycleAction([
    product("SKU1", [{ field: "format", live: null, expected: "Figure" }]),
  ]);
  assert.equal(decision.status, "yellow");
  assert.equal(decision.toWrite.length, 1);
  assert.equal(decision.toWrite[0].sku, "SKU1");
  assert.equal(decision.toWrite[0].field, "format");
  assert.deepEqual(decision.cannotClear, []);
  assert.deepEqual(decision.blocked, []);
});

check("esperado null (precisava de apagar) vai para cannotClear, não para toWrite", () => {
  const decision = decideLiveDriftCycleAction([product("SKU1", [{ field: "format", live: "Figure", expected: null }])]);
  assert.equal(decision.status, "yellow");
  assert.deepEqual(decision.toWrite, []);
  assert.equal(decision.cannotClear.length, 1);
  assert.equal(decision.cannotClear[0].sku, "SKU1");
});

check(`exatamente ${MAX_AUTO_RECONCILE} produtos em drift → ainda yellow (travão é ACIMA de ${MAX_AUTO_RECONCILE})`, () => {
  const products = Array.from({ length: MAX_AUTO_RECONCILE }, (_, i) =>
    product(`SKU${i}`, [{ field: "format", live: null, expected: "Figure" }])
  );
  const decision = decideLiveDriftCycleAction(products);
  assert.equal(decision.status, "yellow");
  assert.equal(decision.toWrite.length, MAX_AUTO_RECONCILE);
  assert.deepEqual(decision.blocked, []);
});

check(`${MAX_AUTO_RECONCILE + 1} produtos em drift → travão dispara, red, nada em toWrite`, () => {
  const products = Array.from({ length: MAX_AUTO_RECONCILE + 1 }, (_, i) =>
    product(`SKU${i}`, [{ field: "format", live: null, expected: "Figure" }])
  );
  const decision = decideLiveDriftCycleAction(products);
  assert.equal(decision.status, "red");
  assert.deepEqual(decision.toWrite, []);
  assert.deepEqual(decision.cannotClear, []);
  assert.equal(decision.blocked.length, MAX_AUTO_RECONCILE + 1);
});

check("um produto pode ter vários campos em drift ao mesmo tempo, contam como 1 produto para o travão", () => {
  const decision = decideLiveDriftCycleAction([
    product("SKU1", [
      { field: "format", live: null, expected: "Figure" },
      { field: "manufacturer_line", live: null, expected: "POP! Rides" },
    ]),
  ]);
  assert.equal(decision.status, "yellow");
  assert.equal(decision.toWrite.length, 2);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nlive-drift-reconcile-cycle: todos os casos passaram");
