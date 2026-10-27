#!/usr/bin/env node
/**
 * PR 4 — I1 a I6 (lib/importer/catalog/characterInvariants.js).
 * Uso: node scripts/tests/character-invariants.test.js
 */
import assert from "node:assert/strict";
import { checkCharacterInvariants } from "../../lib/importer/catalog/characterInvariants.js";

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

const VENDORS = new Set(["Hasbro", "Banpresto"]);
const ids = (r) => r.red.map((x) => x.id);

/** Estado limpo: luke com 1 produto ACTIVE publicado, em alterpop.characters. */
function clean() {
  return {
    characters: new Map([
      ["luke-skywalker", { status: "ACTIVE", universes: ["Star Wars"], products: ["5010994186340"] }],
    ]),
    products: [
      { sku: "5010994186340", status: "ACTIVE", published: true, franchise: "Star Wars", vendor: "Hasbro", characters: ["luke-skywalker"] },
    ],
    universeCharacters: new Map([["Star Wars", ["luke-skywalker"]]]),
    canonicalVendors: VENDORS,
  };
}

check("estado limpo -> sem vermelho nem amarelo", () => {
  const r = checkCharacterInvariants(clean());
  assert.deepEqual(r.red, []);
  assert.deepEqual(r.yellow, []);
});

check("I2: limiar 1 — 1 produto publicado basta para ACTIVE", () => {
  const s = clean();
  s.products[0].characters = ["luke-skywalker"];
  assert.equal(checkCharacterInvariants(s).red.length, 0);
});

check("I2: ACTIVE sem produto publicado -> vermelho", () => {
  const s = clean();
  s.products[0].published = false;
  assert.ok(ids(checkCharacterInvariants(s)).includes("I2"));
});

check("I2: DRAFT com produto ACTIVE publicado -> vermelho", () => {
  const s = clean();
  s.characters.get("luke-skywalker").status = "DRAFT";
  s.universeCharacters = new Map([["Star Wars", []]]);
  assert.ok(ids(checkCharacterInvariants(s)).includes("I2"));
});

check("I2: qa-dead-ref fica fora", () => {
  const s = clean();
  s.characters.set("qa-dead-ref", { status: "ACTIVE", universes: [], products: [] });
  assert.equal(checkCharacterInvariants(s).red.filter((x) => x.handle === "qa-dead-ref").length, 0);
});

check("I1: C.products diferente de alterpop.character -> vermelho", () => {
  const s = clean();
  s.characters.get("luke-skywalker").products = [];
  assert.ok(ids(checkCharacterInvariants(s)).includes("I1"));
});

check("I3: ACTIVE fora de alterpop.characters do universo -> vermelho", () => {
  const s = clean();
  s.universeCharacters = new Map([["Star Wars", []]]);
  assert.ok(ids(checkCharacterInvariants(s)).includes("I3"));
});

check("I4: em alterpop.characters mas DRAFT -> vermelho", () => {
  const s = clean();
  s.characters.get("luke-skywalker").status = "DRAFT";
  s.products[0].published = false;
  assert.ok(ids(checkCharacterInvariants(s)).includes("I4"));
});

check("I5: produto ACTIVE sem franchise -> vermelho", () => {
  const s = clean();
  s.products[0].franchise = "";
  assert.ok(ids(checkCharacterInvariants(s)).includes("I5"));
});

check("I6: vendor fora do mapa -> amarelo, não vermelho", () => {
  const s = clean();
  s.products[0].vendor = "Marca Estranha";
  const r = checkCharacterInvariants(s);
  assert.equal(r.red.length, 0);
  assert.equal(r.yellow[0].id, "I6");
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
