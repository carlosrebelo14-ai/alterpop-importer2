#!/usr/bin/env node
/* eslint-env node */
/**
 * Vocabulário ronda 2 (decisão do arquiteto, 28/10/2026): match mais longo nos casos pedidos e
 * entradas novas. Uso: node scripts/tests/character-vocab-ronda2.test.js
 */
import assert from "node:assert/strict";
import { CHARACTER_VOCABULARY } from "../../lib/importer/catalog/characterVocabulary.js";
import { resolveCharacters } from "../../lib/importer/catalog/characterResolver.server.js";

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

const resolve = (title, resolvedFranchise) => resolveCharacters({ originalTitle: title, resolvedFranchise });

check("\"Yoda the Child\" dá grogu, não yoda", () => {
  assert.deepEqual(resolve("Star Wars The Mandalorian Yoda the Child 25cm", "Star Wars"), ["grogu"]);
});

check("\"Saiyan Rose Goku Black\" dá goku-black, não goku", () => {
  assert.deepEqual(resolve("Dragon Ball Saiyan Rose Goku Black figure 18cm", "Dragon Ball"), ["goku-black"]);
});

check("\"Goku\" sozinho continua a dar goku", () => {
  assert.deepEqual(resolve("Dragon Ball Goku figure 15cm", "Dragon Ball"), ["goku"]);
});

check("alias do vocabulário: \"Frodo Baggins\" dá frodo, existente", () => {
  assert.deepEqual(resolve("The Lord of the Rings Frodo Baggins figure", "The Lord of the Rings"), ["frodo"]);
});

check("alias entre parênteses: \"Whitebeard\" dá edward-newgate", () => {
  assert.deepEqual(resolve("One Piece Whitebeard figure 20cm", "One Piece"), ["edward-newgate"]);
});

check("\"Mr Compress\" dá mr-compress", () => {
  assert.deepEqual(resolve("My Hero Academia Mr Compress figure", "My Hero Academia"), ["mr-compress"]);
});

check("\"Ghost-Spider\" dá gwen-stacy", () => {
  assert.deepEqual(resolve("Ghost-Spider figure 15cm", "Spider-Man"), ["gwen-stacy"]);
});

check("\"Kid Buu\" dá majin-buu", () => {
  assert.deepEqual(resolve("Dragon Ball Kid Buu figure", "Dragon Ball"), ["majin-buu"]);
});

check("\"Orange Piccolo\" dá piccolo, não nenhum outro", () => {
  assert.deepEqual(resolve("Dragon Ball Orange Piccolo figure", "Dragon Ball"), ["piccolo"]);
});

check("variantes fora do vocabulário: Gamma, Dogpool, Last Ronin e Black Knight não entram", () => {
  const nomes = CHARACTER_VOCABULARY.flatMap((e) => e.nomes);
  for (const fora of ["Gamma", "Dogpool", "Last Ronin", "Black Knight"]) {
    assert.equal(nomes.includes(fora), false, fora);
  }
  assert.equal(resolve("Dogpool figure 15cm", "X-Men"), null);
});

check("os novos personagens de ronda 2 resolvem no universo certo", () => {
  assert.deepEqual(resolve("Star Wars Count Dooku figure", "Star Wars"), ["count-dooku"]);
  assert.deepEqual(resolve("Obito Uchiha figure 15cm", "Naruto"), ["obito-uchiha"]);
  assert.deepEqual(resolve("One Piece Monkey D. Garp figure", "One Piece"), ["monkey-d-garp"]);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
