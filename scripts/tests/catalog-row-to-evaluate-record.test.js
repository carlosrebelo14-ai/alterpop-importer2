#!/usr/bin/env node
/**
 * Auditoria 2026-09-22 — catalogRowToEvaluateRecord() (purgeDatabase.server.js) não
 * lia row.franchises, ao contrário de categorySegments (mesmo padrão JSON.parse com
 * fallback). evaluateStructuredCatalogFilter.server.js (detectEliteUniverse,
 * hasPremiumFranchiseTag) lê record.franchises para reconhecer o sinal de
 * fast-track por franquia gravado no import original — sem isto, uma reavaliação de
 * purga (purgeDatabase/purgeEliteCatalog) podia apagar permanentemente um produto
 * elite/VIP legítimo por o record reconstruído ter perdido esse dado.
 *
 * Uso: node scripts/tests/catalog-row-to-evaluate-record.test.js
 */
import assert from "node:assert/strict";
import { catalogRowToEvaluateRecord } from "../../lib/importer/catalog/purgeDatabase.server.js";

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

check("franchises da linha do catálogo entra no record reconstruído", () => {
  const record = catalogRowToEvaluateRecord({
    sku: "sw-001",
    title: "Luke Skywalker Figure",
    vendor: "Hasbro",
    categoryMain: "Toys",
    categorySegments: '["Action Figures"]',
    franchises: '["star wars", "structured_franchise_tag"]',
    netPrice: 10,
    grossPrice: 12,
    stock: 5,
  });
  assert.deepEqual(record.franchises, ["star wars", "structured_franchise_tag"]);
});

check("franchises ausente (null) vira [] em vez de undefined", () => {
  const record = catalogRowToEvaluateRecord({
    sku: "sw-002",
    title: "Generic Toy",
    categoryMain: "Toys",
    stock: 1,
  });
  assert.deepEqual(record.franchises, []);
});

check("franchises com JSON inválido vira [] (mesmo padrão de categorySegments), não lança", () => {
  const record = catalogRowToEvaluateRecord({
    sku: "sw-003",
    title: "Broken Row",
    categoryMain: "Toys",
    franchises: "{not valid json",
    stock: 1,
  });
  assert.deepEqual(record.franchises, []);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ncatalog-row-to-evaluate-record: todos os casos passaram");
