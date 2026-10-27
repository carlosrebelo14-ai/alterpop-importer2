#!/usr/bin/env node
/**
 * 27/10/2026 — verify-character-invariants: comparação por GID (lib/importer/catalog/characterInvariantInput.js).
 * Fixture com os GIDs reais da loja (frodo, Minix, Lord of the Rings). A segunda parte prova
 * por mutação o falso vermelho de hoje: nós sem `id` deixam o mapa GID → handle vazio.
 * Uso: node scripts/tests/verify-characters-gid.test.js
 */
import assert from "node:assert/strict";
import { checkCharacterInvariants } from "../../lib/importer/catalog/characterInvariants.js";
import { buildInvariantInput } from "../../lib/importer/catalog/characterInvariantInput.js";

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

const FRODO = "gid://shopify/Metaobject/662126395722";
const LOTR = "gid://shopify/Collection/712037335370";
const PRODUCT = "gid://shopify/Product/16130884337994";

function fixture({ withIds = true } = {}) {
  return {
    characterNodes: [
      {
        ...(withIds ? { id: FRODO } : {}),
        handle: "frodo",
        capabilities: { publishable: { status: "ACTIVE" } },
        universe: { value: JSON.stringify([LOTR]) },
        products: { value: JSON.stringify([PRODUCT]) },
      },
    ],
    productNodes: [
      {
        id: PRODUCT,
        sku: "8436605116143",
        status: "ACTIVE",
        vendor: "Minix",
        franchise: { value: JSON.stringify(["The Lord of the Rings"]) },
        character: { value: JSON.stringify([FRODO]) },
      },
    ],
    universeCollections: [
      { name: "The Lord of the Rings", id: LOTR, characters: { value: JSON.stringify([FRODO]) } },
    ],
  };
}

const CANON = new Set(["Minix"]);
const run = (input) => {
  const state = buildInvariantInput(input);
  return checkCharacterInvariants({ ...state, universeCharacters: state.universeCharacters, canonicalVendors: CANON });
};

check("GID real: alterpop.character e C.products batem -> sem I1 vermelho", () => {
  const { red } = run(fixture());
  assert.deepEqual(red.filter((r) => r.id === "I1"), []);
});

check("GID real: frodo ligado ao produto, sem I2/I3/I4 vermelho", () => {
  const { red } = run(fixture());
  assert.deepEqual(red, []);
});

check("GID real: o produto aparece em alterpop.character como handle frodo", () => {
  const state = buildInvariantInput(fixture());
  assert.deepEqual(state.products[0].characters, ["frodo"]);
  assert.deepEqual(state.characters.get("frodo").products, ["8436605116143"]);
  assert.deepEqual(state.universeCharacters.get("The Lord of the Rings"), ["frodo"]);
});

check("mutação (falso vermelho de hoje): nós sem id -> I1 vermelho com o estado real", () => {
  const { red } = run(fixture({ withIds: false }));
  assert.ok(red.some((r) => r.id === "I1" && r.handle === "frodo"), "a mutação tinha de provocar I1 em frodo");
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
