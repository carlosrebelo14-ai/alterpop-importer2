#!/usr/bin/env node
/**
 * ADENDA 1 (briefing backend, 17/09/2026) — os 15 nomes do piloto de 14/09 (Star Wars,
 * Dragon Ball, Batman), acrescentados a characterVocabulary.js.
 * Uso: node scripts/tests/character-vocabulary.test.js
 */
import assert from "node:assert/strict";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";
import {
  CHARACTER_VOCABULARY,
  CHARACTER_ALIASES,
  PASSAGEM_B_NAMES,
  EPONYM_CANDIDATES,
  EPONYM_OVERRIDES,
} from "../../lib/importer/catalog/characterVocabulary.js";
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

const universoNames = new Set(FRANCHISE_UNIVERSES.map((u) => u.name));
const byUniverso = Object.fromEntries(CHARACTER_VOCABULARY.map((e) => [e.universo, e.nomes]));

check("LOTR: lista D3 de 27/10/2026 completa, sem criaturas genéricas", () => {
  const lotr = CHARACTER_VOCABULARY.find((e) => e.universo === "The Lord of the Rings");
  for (const nome of ["Frodo", "Gandalf", "Aragorn", "Gollum", "Legolas", "Gimli", "Boromir", "Merry", "Pippin", "Sam", "Sauron", "Saruman", "Éowyn", "Éomer", "Arwen", "Elrond", "Faramir", "Witch-King", "Balrog", "Lurtz", "Mouth of Sauron"]) {
    assert.ok(lotr.nomes.includes(nome), `falta ${nome}`);
  }
  for (const fora of ["Moria Orc", "Cave Troll", "Nazgûl"]) assert.ok(!lotr.nomes.includes(fora), `não devia entrar ${fora}`);
});

check("resolver: Mouth of Sauron dá só mouth-of-sauron (Sauron contido no trecho não conta)", () => {
  assert.deepEqual(resolveCharacters({ originalTitle: "LOTR Mouth of Sauron 18cm", resolvedFranchise: "The Lord of the Rings" }), ["mouth-of-sauron"]);
});

check("resolver: Frodo Baggins & Gollum dá os dois (trechos não se sobrepõem)", () => {
  assert.deepEqual(resolveCharacters({ originalTitle: "LOTR Frodo Baggins & Gollum set", resolvedFranchise: "The Lord of the Rings" }), ["frodo", "gollum"]);
});

check("Witch-King: títulos com e sem hífen ligam a witch-king (os dois produtos ACTIVE de 27/10/2026)", () => {
  for (const t of ["The Lord of the Rings Witch King", "The Lord of the Rings Witch King with Fellbeast", "The Lord of the Rings Witch-King", "The Lord of the Rings Witch-King with Fellbeast"]) {
    assert.deepEqual(resolveCharacters({ originalTitle: t, resolvedFranchise: "The Lord of the Rings" }), ["witch-king"], t);
  }
});

check("LOTR: aliases D3 resolvem para o handle do personagem", () => {
  assert.deepEqual(resolveCharacters({ originalTitle: "LOTR Samwise Gamgee figure", resolvedFranchise: "The Lord of the Rings" }), ["sam"]);
  assert.deepEqual(resolveCharacters({ originalTitle: "LOTR Eowyn figure", resolvedFranchise: "The Lord of the Rings" }), ["eowyn"]);
});

check("todos os universos do vocabulário batem exatamente com FRANCHISE_UNIVERSES", () => {
  for (const entry of CHARACTER_VOCABULARY) {
    assert.ok(universoNames.has(entry.universo), `"${entry.universo}" não existe em FRANCHISE_UNIVERSES`);
  }
});

check("os 15 nomes do piloto (PR #71) entram no vocabulário", () => {
  for (const n of ["Darth Vader", "Luke Skywalker", "Ahsoka Tano", "Grogu", "Din Djarin"]) assert.ok(byUniverso["Star Wars"].includes(n), n);
  for (const n of ["Goku", "Vegeta", "Gohan", "Frieza", "Piccolo"]) assert.ok(byUniverso["Dragon Ball"].includes(n), n);
  for (const n of ["Batman", "Joker", "Harley Quinn", "Catwoman", "Robin"]) assert.ok(byUniverso["Batman"].includes(n), n);
});

check("Din Djarin fica sem o alias The Mandalorian (colisão com a Line)", () => {
  assert.deepEqual(CHARACTER_ALIASES["Din Djarin"], ["Mando"]);
  for (const aliases of Object.values(CHARACTER_ALIASES)) {
    assert.ok(!aliases.includes("The Mandalorian"), "The Mandalorian não pode ser alias de nenhum nome");
  }
});

check("aliases copiados do censo do PR #71 (Ahsoka, Grogu, Frieza)", () => {
  assert.deepEqual(CHARACTER_ALIASES["Ahsoka Tano"], ["Ahsoka"]);
  assert.deepEqual(CHARACTER_ALIASES["Grogu"], ["Baby Yoda", "The Child", "Yoda the Child"]); // ronda 2, 28/10/2026
  assert.deepEqual(CHARACTER_ALIASES["Frieza"], ["Freezer"]);
});

check("os 10 nomes com passagem A e B existem no vocabulário", () => {
  const todosOsNomes = new Set(CHARACTER_VOCABULARY.flatMap((e) => e.nomes));
  for (const nome of PASSAGEM_B_NAMES) {
    assert.ok(todosOsNomes.has(nome), `"${nome}" (passagem B) não está no vocabulário`);
  }
  assert.equal(PASSAGEM_B_NAMES.length, 10);
});

check("Batman tem exceção registada à régua dos epónimos, com a data da decisão", () => {
  const override = EPONYM_OVERRIDES.find((o) => o.nome === "Batman");
  assert.ok(override, "Batman não está em EPONYM_OVERRIDES");
  assert.equal(override.decisao, "2026-09-17");
});

check("exclusão dos epónimos revogada (ronda 1, 28/10/2026): lista de candidatos vazia; Batman continua registado", () => {
  assert.equal(EPONYM_CANDIDATES.length, 0);
  assert.ok(EPONYM_OVERRIDES.some((o) => o.nome === "Batman"));
});


console.log(`\n${failures === 0 ? "OK" : "FALHOU"} — ${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
