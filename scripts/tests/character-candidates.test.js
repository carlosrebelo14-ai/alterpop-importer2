#!/usr/bin/env node
/**
 * Pipeline de vocabulário — extração de candidatos (lib/importer/catalog/characterCandidates.js).
 * Uso: node scripts/tests/character-candidates.test.js
 */
import assert from "node:assert/strict";
import { extractCandidateName } from "../../lib/importer/catalog/characterCandidates.js";

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

const SW = ["Star Wars"];
const LOTR = ["Lord of the Rings"];

check("franquia, vendor, medida e descritor saem; sobra o nome", () => {
  assert.equal(extractCandidateName("Star Wars Luke Skywalker lightsaber 18cm", { franchisePatterns: SW, vendor: "Hasbro" }), "Luke Skywalker");
});

check("corte no separador: o nome vem antes do traço", () => {
  assert.equal(extractCandidateName("Funko Pop! Harry Potter - Hermione Granger", { franchisePatterns: ["Harry Potter"], vendor: "Funko" }), "Hermione Granger");
});

check("número para a leitura: 'Gear 5' fica em Luffy Gear", () => {
  assert.equal(extractCandidateName("One Piece Luffy Gear 5 figure 17cm", { franchisePatterns: ["One Piece"], vendor: "Banpresto" }), "Luffy Gear");
});

check("título só com franquia não dá candidato", () => {
  assert.equal(extractCandidateName("Star Wars", { franchisePatterns: SW, vendor: "Hasbro" }), null);
});

check("hífen dentro do nome fica (Witch-King)", () => {
  assert.equal(extractCandidateName("The Lord of the Rings Witch-King with Fellbeast", { franchisePatterns: LOTR, vendor: "Diamond Select" }), "Witch-King");
});

check("título vazio ou nulo não rebenta", () => {
  assert.equal(extractCandidateName("", {}), null);
  assert.equal(extractCandidateName(null, {}), null);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
