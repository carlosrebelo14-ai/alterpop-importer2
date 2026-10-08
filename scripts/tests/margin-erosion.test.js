#!/usr/bin/env node
/**
 * Revisão do dry-run de preços (07/10/2026) — computeMarginErosion
 * (lib/importer/curation/marginErosion.server.js): preço live contra o custo atual do
 * feed, vermelho abaixo de 10 % de margem efetiva, sem valor de referência guardado.
 * Uso: node scripts/tests/margin-erosion.test.js
 */
import assert from "node:assert/strict";
import { computeMarginErosion, MARGIN_EROSION_RED_PCT } from "../../lib/importer/curation/marginErosion.server.js";

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

const run = (rows) =>
  computeMarginErosion({
    published: rows.map((r) => ({ sku: r.sku })),
    catalogBySku: new Map(rows.filter((r) => r.cat !== undefined).map((r) => [r.sku, r.cat])),
    liveBySku: new Map(rows.filter((r) => r.live !== undefined).map((r) => [r.sku, r.live])),
    missingLiveReasons: new Map(rows.filter((r) => r.why).map((r) => [r.sku, r.why])),
  });

check("limiar é 10 %", () => assert.equal(MARGIN_EROSION_RED_PCT, 10));

check("Pop a 17,50 com custo 12,09 → 44,7 %, não alerta", () => {
  const r = run([{ sku: "a", cat: { distributorPrice: 9.99 }, live: { price: 17.5 } }]);
  assert.equal(r.red.length, 0);
  assert.equal(r.measured, 1);
});

check("custo subiu: live 17,50, custo 16,99 × 1,21 = 20,56 → margem negativa, vermelho", () => {
  const r = run([{ sku: "a", cat: { distributorPrice: 16.99 }, live: { price: 17.5 } }]);
  assert.equal(r.red.length, 1);
  assert.equal(r.red[0].cost, 20.56);
  assert.equal(r.red[0].effectiveMarginPct, -14.9);
});

check("fronteira: 10 % exatos não alerta, 9,9 % alerta", () => {
  // dist 10,00 → custo 12,10; 12,10 × 1,10 = 13,31
  const exact = run([{ sku: "a", cat: { distributorPrice: 10 }, live: { price: 13.31 } }]);
  assert.equal(exact.red.length, 0, JSON.stringify(exact.red));
  const below = run([{ sku: "a", cat: { distributorPrice: 10 }, live: { price: 13.3 } }]);
  assert.equal(below.red.length, 1);
});

check("9,95 % é vermelho (decisão exata, não arredondada) e mostra 9,9 %", () => {
  // dist 16,53 → custo 20,00; live 21,99 → 9,95 %
  const r = run([{ sku: "a", cat: { distributorPrice: 16.53 }, live: { price: 21.99 } }]);
  assert.equal(r.red.length, 1);
  assert.equal(r.red[0].effectiveMarginPct, 9.9);
});

check("ordenado do pior para o melhor", () => {
  const r = run([
    { sku: "a", cat: { distributorPrice: 10 }, live: { price: 13 } },
    { sku: "b", cat: { distributorPrice: 10 }, live: { price: 11 } },
  ]);
  assert.deepEqual(r.red.map((x) => x.sku), ["b", "a"]);
});

check("sem variante live → sem dados, com a causa do diagnóstico", () => {
  const r = run([{ sku: "0030506556343", cat: { distributorPrice: 23.99 }, why: "produto X apagado na Shopify em 2026-09-17" }]);
  assert.equal(r.noData.length, 1);
  assert.match(r.noData[0].reason, /apagado/);
  assert.equal(r.measured, 0);
});

check("sem precio_distribuidores no catálogo → sem dados, nunca margem inventada", () => {
  const r = run([{ sku: "a", cat: { distributorPrice: null }, live: { price: 17.5 } }]);
  assert.equal(r.noData.length, 1);
  assert.match(r.noData[0].reason, /precio_distribuidores/);
});

check("fora do catálogo → sem dados", () => {
  const r = run([{ sku: "a", live: { price: 17.5 } }]);
  assert.equal(r.noData.length, 1);
});

check("SKU duplicado no live → sem dados", () => {
  const r = run([{ sku: "a", cat: { distributorPrice: 9.99 }, live: { price: 17.5, duplicate: true } }]);
  assert.equal(r.noData.length, 1);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
