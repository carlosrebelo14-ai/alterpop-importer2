#!/usr/bin/env node
/**
 * B7 (briefing backend, 17/09/2026) — characterPages.server.js, secção 6 do arranque.
 * Uso: node scripts/tests/character-pages.test.js
 */
import assert from "node:assert/strict";
import {
  planCharacterMetaobjects,
  planUniverseCharacterCollections,
  buildCharacterCatalog,
  CHARACTER_THRESHOLD,
  CHARACTER_PRODUCTS_MAX,
} from "../../lib/importer/catalog/characterPages.server.js";

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

check("chega a 3, sem metaobject prévio -> create", () => {
  const actions = planCharacterMetaobjects({
    liveCounts: new Map([["luffy", { universo: "One Piece", productSkus: ["a", "b", "c"] }]]),
    existing: new Map(),
  });
  const a = actions.find((x) => x.handle === "luffy");
  assert.equal(a.action, "create");
  assert.equal(a.targetStatus, "ACTIVE");
  assert.equal(a.nome, "Luffy");
  assert.equal(a.universo, "One Piece");
});

check("já ACTIVE, continua em 3+ -> update", () => {
  const actions = planCharacterMetaobjects({
    liveCounts: new Map([["luffy", { universo: "One Piece", productSkus: ["a", "b", "c", "d"] }]]),
    existing: new Map([["luffy", { id: "gid://shopify/Metaobject/1", status: "ACTIVE" }]]),
  });
  const a = actions.find((x) => x.handle === "luffy");
  assert.equal(a.action, "update");
});

check("já DRAFT, volta a bater o limiar -> reactivate", () => {
  const actions = planCharacterMetaobjects({
    liveCounts: new Map([["grogu", { universo: "Star Wars", productSkus: ["a", "b", "c"] }]]),
    existing: new Map([["grogu", { id: "gid://shopify/Metaobject/2", status: "DRAFT" }]]),
  });
  const a = actions.find((x) => x.handle === "grogu");
  assert.equal(a.action, "reactivate");
  assert.equal(a.targetStatus, "ACTIVE");
});

check("desce abaixo de 3, já ACTIVE -> set-draft, sem productSkus (não mexe)", () => {
  const actions = planCharacterMetaobjects({
    liveCounts: new Map([["grogu", { universo: "Star Wars", productSkus: ["a"] }]]),
    existing: new Map([["grogu", { id: "gid://shopify/Metaobject/2", status: "ACTIVE" }]]),
  });
  const a = actions.find((x) => x.handle === "grogu");
  assert.equal(a.action, "set-draft");
  assert.equal(a.targetStatus, "DRAFT");
  assert.equal(a.productSkus, undefined);
});

check("nunca teve metaobject, abaixo do limiar -> skip", () => {
  const actions = planCharacterMetaobjects({
    liveCounts: new Map([["elsa", { universo: "Frozen", productSkus: ["a"] }]]),
    existing: new Map(),
  });
  const a = actions.find((x) => x.handle === "elsa");
  assert.equal(a.action, "skip");
});

check("existe no vocabulário mas sem produto live nenhum -> skip (count 0)", () => {
  const actions = planCharacterMetaobjects({ liveCounts: new Map(), existing: new Map() });
  assert.equal(actions.length, 0); // sem liveCounts nem existing, nada a decidir
});

check(`mais de ${CHARACTER_PRODUCTS_MAX} produtos -> error, nunca truncar`, () => {
  const skus = Array.from({ length: CHARACTER_PRODUCTS_MAX + 1 }, (_, i) => `sku-${i}`);
  const actions = planCharacterMetaobjects({
    liveCounts: new Map([["luffy", { universo: "One Piece", productSkus: skus }]]),
    existing: new Map(),
  });
  const a = actions.find((x) => x.handle === "luffy");
  assert.equal(a.action, "error");
  assert.ok(a.error.includes("nunca truncar"));
});

check(`exatamente ${CHARACTER_THRESHOLD} produtos -> já bate o limiar`, () => {
  const actions = planCharacterMetaobjects({
    liveCounts: new Map([["harley-quinn", { universo: "Batman", productSkus: ["a", "b", "c"] }]]),
    existing: new Map(),
  });
  assert.equal(actions.find((x) => x.handle === "harley-quinn").action, "create");
});

check("nome epónimo bloqueado nunca aparece no catálogo de handles (Harry)", () => {
  const catalog = buildCharacterCatalog();
  assert.ok(!catalog.has("harry"));
});

check("Batman (override) aparece no catálogo de handles", () => {
  const catalog = buildCharacterCatalog();
  assert.deepEqual(catalog.get("batman"), { nome: "Batman", universo: "Batman" });
});

check("planUniverseCharacterCollections agrupa por universo, maior contagem primeiro", () => {
  const actions = planCharacterMetaobjects({
    liveCounts: new Map([
      ["luffy", { universo: "One Piece", productSkus: ["a", "b", "c", "d", "e"] }],
      ["zoro", { universo: "One Piece", productSkus: ["f", "g", "h"] }],
      ["luke-skywalker", { universo: "Star Wars", productSkus: ["i", "j", "k"] }],
    ]),
    existing: new Map(),
  });
  const plan = planUniverseCharacterCollections(actions);
  assert.deepEqual(plan.get("One Piece"), ["luffy", "zoro"]);
  assert.deepEqual(plan.get("Star Wars"), ["luke-skywalker"]);
});

check("planUniverseCharacterCollections não inclui set-draft/skip/error", () => {
  const actions = planCharacterMetaobjects({
    liveCounts: new Map([["grogu", { universo: "Star Wars", productSkus: ["a"] }]]),
    existing: new Map([["grogu", { id: "gid://shopify/Metaobject/2", status: "ACTIVE" }]]),
  });
  const plan = planUniverseCharacterCollections(actions);
  assert.ok(!plan.has("Star Wars"));
});

console.log(`\n${failures === 0 ? "OK" : "FALHOU"} — ${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
