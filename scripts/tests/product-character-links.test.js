#!/usr/bin/env node
/**
 * PR 4 — planeamento das ligações ProductCharacter (lib/importer/catalog/productCharacterLinks.js).
 * Inclui a fixture do lightsaber (SKU 5010994186340), pedida pelo arquiteto em 27/10/2026.
 * Uso: node scripts/tests/product-character-links.test.js
 */
import assert from "node:assert/strict";
import {
  planProductCharacterLinks,
  storeLinkRows,
  productToCharactersReport,
  ORIGEM_STORE,
  ORIGEM_RESOLVER,
} from "../../lib/importer/catalog/productCharacterLinks.js";

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

const LIGHTSABER = {
  sku: "5010994186340",
  originalTitle: "Star Wars FX Elite Luke Skywalker Lightsaber replica",
  titleOverride: null,
  resolvedFranchise: "Star Wars",
};

check("lightsaber (SKU 5010994186340) -> luke-skywalker no dry-run de B2", () => {
  const plan = planProductCharacterLinks({ products: [LIGHTSABER], existingLinks: new Map() });
  assert.deepEqual(plan[0].add, [{ characterHandle: "luke-skywalker", origem: ORIGEM_RESOLVER }]);
  const report = productToCharactersReport(plan);
  assert.deepEqual(report, [{ sku: "5010994186340", characters: ["luke-skywalker"] }]);
});

check("sem franchise resolvida -> nada a acrescentar, nada a remover", () => {
  const plan = planProductCharacterLinks({
    products: [{ ...LIGHTSABER, resolvedFranchise: null }],
    existingLinks: new Map(),
  });
  assert.equal(plan[0].resolved, null);
  assert.deepEqual(plan[0].add, []);
  assert.equal(plan[0].unchanged, true);
});

check("ligação store nunca é removida pelo resolver (A4)", () => {
  const existing = new Map([
    ["5010994186340", [{ characterHandle: "luke-skywalker", origem: ORIGEM_STORE }]],
  ]);
  const plan = planProductCharacterLinks({
    products: [{ ...LIGHTSABER, originalTitle: "Star Wars Mandalorian helmet", resolvedFranchise: "Star Wars" }],
    existingLinks: existing,
  });
  assert.deepEqual(plan[0].remove, []);
  assert.equal(plan[0].unchanged, true);
});

check("ligação do resolver sai quando o título deixa de a justificar", () => {
  const existing = new Map([
    ["5010994186340", [{ characterHandle: "luke-skywalker", origem: ORIGEM_RESOLVER }]],
  ]);
  const plan = planProductCharacterLinks({
    products: [{ ...LIGHTSABER, originalTitle: "Star Wars Mandalorian helmet" }],
    existingLinks: existing,
  });
  assert.deepEqual(plan[0].remove, ["luke-skywalker"]);
});

check("titleOverride manda sobre originalTitle", () => {
  const plan = planProductCharacterLinks({
    products: [{ ...LIGHTSABER, titleOverride: "Star Wars Mandalorian helmet" }],
    existingLinks: new Map(),
  });
  assert.equal(plan[0].resolved, null);
  assert.deepEqual(plan[0].add, []);
});

check("store já ligado e resolver igual -> sem alteração", () => {
  const existing = new Map([
    ["5010994186340", [{ characterHandle: "luke-skywalker", origem: ORIGEM_STORE }]],
  ]);
  const plan = planProductCharacterLinks({ products: [LIGHTSABER], existingLinks: existing });
  assert.deepEqual(plan[0].add, []);
  assert.equal(plan[0].unchanged, true);
});

check("B1: alterpop.character da loja vira linhas origem store", () => {
  const rows = storeLinkRows([{ sku: "A1", handles: ["luffy", "luffy"], universeHandle: "one-piece" }]);
  assert.deepEqual(rows, [{ sku: "A1", characterHandle: "luffy", universeHandle: "one-piece", origem: ORIGEM_STORE }]);
});

check("filtro LOTR: legolas sem metaobject fica de fora e aparece em excluded", () => {
  const plan = planProductCharacterLinks({
    products: [{ sku: "L1", originalTitle: "Legolas bow replica", resolvedFranchise: "The Lord of the Rings" }],
    existingLinks: new Map(),
    metaobjectHandles: new Set(["gandalf", "ahsoka-tano"]),
  });
  assert.deepEqual(plan[0].add, []);
  assert.deepEqual(plan[0].excluded, ["legolas"]);
});

check("filtro LOTR: gandalf com metaobject entra", () => {
  const plan = planProductCharacterLinks({
    products: [{ sku: "G1", originalTitle: "Gandalf the Grey statue", resolvedFranchise: "The Lord of the Rings" }],
    existingLinks: new Map(),
    metaobjectHandles: new Set(["gandalf"]),
  });
  assert.deepEqual(plan[0].add, [{ characterHandle: "gandalf", origem: ORIGEM_RESOLVER }]);
  assert.deepEqual(plan[0].excluded, []);
});

check("filtro LOTR: ahsoka-tano (Star Wars) entra mesmo sem filtro de LOTR", () => {
  const plan = planProductCharacterLinks({
    products: [{ sku: "A1", originalTitle: "Ahsoka Tano figure", resolvedFranchise: "Star Wars" }],
    existingLinks: new Map(),
    metaobjectHandles: new Set(),
  });
  assert.deepEqual(plan[0].add, [{ characterHandle: "ahsoka-tano", origem: ORIGEM_RESOLVER }]);
  assert.deepEqual(plan[0].excluded, []);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
