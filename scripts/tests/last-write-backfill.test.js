#!/usr/bin/env node
/**
 * Briefing "Aplicar aos publicados", passo 2 — plano do preenchimento inicial da última
 * escrita (planLastWriteBackfill, puro). Uso: node scripts/tests/last-write-backfill.test.js
 */
import assert from "node:assert/strict";
import { planLastWriteBackfill } from "../../lib/importer/pricing/lastWriteBackfill.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}

const cat = new Map([["GANDALF", { distributorPrice: 9.99, grossPrice: 17.95 }]]);
const run = (over = {}) =>
  planLastWriteBackfill({
    items: [{ sku: "GANDALF", metadata: {} }],
    liveBySku: new Map([["GANDALF", { price: 14.9 }]]),
    catalogBySku: cat,
    globalPct: 10,
    now: new Date("2026-10-09T12:00:00Z"),
    ...over,
  });

check("Gandalf: live 14,90 → margem estimada 20 (intervalo 20–23), regra agora 14,50", () => {
  const [r] = run();
  assert.equal(r.action, "RECORD");
  assert.equal(r.marginPct, 20);
  assert.deepEqual(r.range, [20, 23]);
  assert.equal(r.ambiguous, true);
  assert.equal(r.ruleNow, 14.5);
  assert.equal(r.write.price, 14.9);
  assert.equal(r.write.source, "backfill");
  assert.equal(r.write.marginInferred, true);
  assert.equal(r.write.cost, 12.09);
  assert.equal(r.write.at, "2026-10-09T12:00:00.000Z");
});
check("preço live que nenhuma margem reproduz: fica na lista com aviso de possível preço manual", () => {
  const [r] = run({ liveBySku: new Map([["GANDALF", { price: 16.33 }]]) });
  assert.equal(r.action, "RECORD");
  assert.equal(r.marginPct, null);
  assert.match(r.reason, /possível preço manual/);
  assert.equal(r.write.marginInferred, undefined);
});
check("item que já tem última escrita não é tocado", () => {
  const [r] = run({ items: [{ sku: "GANDALF", metadata: { lastPriceWrite: { price: 14.9 } } }] });
  assert.equal(r.action, "SKIP");
  assert.match(r.reason, /já tem/);
});
check("sem variante live, duplicado, preço inválido, fora do catálogo: SKIP com a razão", () => {
  assert.match(run({ liveBySku: new Map() })[0].reason, /sem variante live/);
  assert.match(run({ liveBySku: new Map([["GANDALF", { price: 14.9, duplicate: true }]]) })[0].reason, /mais de uma variante/);
  assert.match(run({ liveBySku: new Map([["GANDALF", { price: 0 }]]) })[0].reason, /inválido/);
  assert.match(run({ catalogBySku: new Map() })[0].reason, /fora do catálogo/);
  for (const reasonRow of [run({ liveBySku: new Map() })[0], run({ catalogBySku: new Map() })[0]]) assert.equal(reasonRow.write, null);
});
check("--skip exclui o SKU", () => {
  const [r] = run({ skip: new Set(["GANDALF"]) });
  assert.equal(r.action, "SKIP");
});
check("sem custo no catálogo: SKIP com o erro de preço, nunca grava", () => {
  const [r] = run({ catalogBySku: new Map([["GANDALF", { distributorPrice: null, grossPrice: 17.95 }]]) });
  assert.equal(r.action, "SKIP");
  assert.match(r.reason, /sem preço calculado/);
});

const floorCat = new Map([["PISO", { distributorPrice: 7.99, grossPrice: 14.95 }]]);
const runFloor = (over = {}) =>
  planLastWriteBackfill({
    items: [{ sku: "PISO", metadata: {} }],
    liveBySku: new Map([["PISO", { price: 12.5 }]]),
    catalogBySku: floorCat,
    globalPct: 10,
    ...over,
  });
check("preço preso ao piso do PVPR: margem de origem desconhecida, nunca o 5 % do limite inferior", () => {
  const [r] = runFloor();
  assert.equal(r.action, "RECORD");
  assert.equal(r.marginPct, null);
  assert.equal(r.write.marginPct, null);
  assert.equal(r.write.marginInferred, undefined);
  assert.match(r.reason, /piso\/teto/);
});
check("--assume-margin 20 grava 20 onde o 20 reproduz o preço live (Gandalf e o preso ao piso)", () => {
  const [g] = run({ assumeMargin: 20 });
  assert.equal(g.marginPct, 20);
  assert.equal(g.assumed, true);
  assert.equal(g.write.marginPct, 20);
  const [p] = runFloor({ assumeMargin: 20 });
  assert.equal(p.marginPct, 20);
});
check("--assume-margin fora do intervalo que reproduz o preço é ignorado", () => {
  const [g] = run({ assumeMargin: 40 }); // 40 % dá 17,50, não 14,90
  assert.equal(g.assumed, false);
  assert.equal(g.marginPct, 20); // volta ao limite inferior (estado MARGEM)
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
