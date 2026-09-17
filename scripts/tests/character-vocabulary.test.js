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

check("todos os universos do vocabulário batem exatamente com FRANCHISE_UNIVERSES", () => {
  for (const entry of CHARACTER_VOCABULARY) {
    assert.ok(universoNames.has(entry.universo), `"${entry.universo}" não existe em FRANCHISE_UNIVERSES`);
  }
});

check("os 15 nomes do piloto (PR #71) entram no vocabulário", () => {
  assert.deepEqual(byUniverso["Star Wars"], ["Darth Vader", "Luke Skywalker", "Ahsoka Tano", "Grogu", "Din Djarin"]);
  assert.deepEqual(byUniverso["Dragon Ball"], ["Goku", "Vegeta", "Gohan", "Frieza", "Piccolo"]);
  assert.deepEqual(byUniverso["Batman"], ["Batman", "Joker", "Harley Quinn", "Catwoman", "Robin"]);
});

check("Din Djarin fica sem o alias The Mandalorian (colisão com a Line)", () => {
  assert.deepEqual(CHARACTER_ALIASES["Din Djarin"], ["Mando"]);
  for (const aliases of Object.values(CHARACTER_ALIASES)) {
    assert.ok(!aliases.includes("The Mandalorian"), "The Mandalorian não pode ser alias de nenhum nome");
  }
});

check("aliases copiados do censo do PR #71 (Ahsoka, Grogu, Frieza)", () => {
  assert.deepEqual(CHARACTER_ALIASES["Ahsoka Tano"], ["Ahsoka"]);
  assert.deepEqual(CHARACTER_ALIASES["Grogu"], ["Baby Yoda", "The Child"]);
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

check("a régua dos epónimos continua a valer, sem exceção, para os outros 8 candidatos", () => {
  const overridden = new Set(EPONYM_OVERRIDES.map((o) => o.nome));
  // Spider-Man já fica fora por não bater o limiar (nota do arranque) — não é uma
  // exceção à régua, é o resultado normal dela. Só Batman tem override.
  const outros = EPONYM_CANDIDATES.map((c) => c.nome).filter((n) => n !== "Batman" && n !== "Spider-Man");
  assert.equal(outros.length, 8);
  for (const nome of outros) {
    assert.ok(!overridden.has(nome), `"${nome}" não devia ter exceção à régua dos epónimos`);
  }
});

console.log(`\n${failures === 0 ? "OK" : "FALHOU"} — ${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
