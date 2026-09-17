#!/usr/bin/env node
/**
 * ADENDA 1/2 (briefing backend, 17/09/2026) — characterResolver.server.js, testes
 * obrigatórios da secção 5 do arranque B7 Character.
 * Uso: node scripts/tests/character-resolver.test.js
 */
import assert from "node:assert/strict";
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

check('"Star Wars Luke Skywalker & Grogu" -> [luke-skywalker, grogu]', () => {
  const out = resolveCharacters({
    originalTitle: "Star Wars Luke Skywalker & Grogu",
    resolvedFranchise: "Star Wars",
  });
  assert.deepEqual(out, ["luke-skywalker", "grogu"]);
});

check('"One Piece Monkey.D.Luffy Grandline Series" -> [luffy]', () => {
  const out = resolveCharacters({
    originalTitle: "One Piece Monkey.D.Luffy Grandline Series",
    resolvedFranchise: "One Piece",
  });
  assert.deepEqual(out, ["luffy"]);
});

check('"One Piece Dioramatic The Anime D Luffy Monkey" -> [luffy]', () => {
  const out = resolveCharacters({
    originalTitle: "One Piece Dioramatic The Anime D Luffy Monkey",
    resolvedFranchise: "One Piece",
  });
  assert.deepEqual(out, ["luffy"]);
});

check('título com "Robin" fora de Batman -> sem robin', () => {
  const out = resolveCharacters({
    originalTitle: "TMNT Robin Hood crossover figure",
    resolvedFranchise: "TMNT",
  });
  assert.ok(out == null || !out.includes("robin"));
});

check('"Robin" dentro de Batman -> com robin', () => {
  const out = resolveCharacters({
    originalTitle: "Batman Robin figure",
    resolvedFranchise: "Batman",
  });
  assert.ok(out.includes("robin"));
});

check("originalTitle com Luke, titleOverride sem Luke -> sem luke-skywalker", () => {
  const out = resolveCharacters({
    originalTitle: "Star Wars Luke Skywalker figure",
    titleOverride: "Star Wars Darth Vader figure",
    resolvedFranchise: "Star Wars",
  });
  assert.deepEqual(out, ["darth-vader"]);
  assert.ok(!out.includes("luke-skywalker"));
});

check("nome da lista dos epónimos nunca aparece (Harry Potter)", () => {
  const out = resolveCharacters({
    originalTitle: "Harry Potter Harry wand replica",
    resolvedFranchise: "Harry Potter",
  });
  assert.ok(out == null || !out.includes("harry"));
});

check("nome da lista dos epónimos nunca aparece (Zelda), mesmo com outro nome do universo presente", () => {
  const out = resolveCharacters({
    originalTitle: "The Legend of Zelda Link and Zelda figure set",
    resolvedFranchise: "The Legend of Zelda",
  });
  assert.deepEqual(out, ["link"]);
});

check("Batman é exceção à régua dos epónimos e aparece", () => {
  const out = resolveCharacters({
    originalTitle: "Batman figure 12cm",
    resolvedFranchise: "Batman",
  });
  assert.deepEqual(out, ["batman"]);
});

check("um nome só conta dentro do universo esperado (Luffy fora de One Piece não conta)", () => {
  const out = resolveCharacters({
    originalTitle: "Star Wars Luke Skywalker figure",
    resolvedFranchise: "Star Wars",
  });
  assert.ok(!out.includes("luffy"));
});

check("aliases contam como o nome próprio (Din Djarin via Mando)", () => {
  const out = resolveCharacters({
    originalTitle: "Star Wars Mando figure",
    resolvedFranchise: "Star Wars",
  });
  assert.deepEqual(out, ["din-djarin"]);
});

check('alias removido "The Mandalorian" não conta para Din Djarin', () => {
  const out = resolveCharacters({
    originalTitle: "Star Wars The Mandalorian figure",
    resolvedFranchise: "Star Wars",
  });
  assert.ok(out == null || !out.includes("din-djarin"));
});

check("sem resolvedFranchise -> null", () => {
  assert.equal(resolveCharacters({ originalTitle: "Star Wars Luke Skywalker" }), null);
});

check("sem título -> null", () => {
  assert.equal(resolveCharacters({ resolvedFranchise: "Star Wars" }), null);
});

check("franquia sem entrada no vocabulário -> null", () => {
  assert.equal(
    resolveCharacters({ originalTitle: "Frozen Elsa figure", resolvedFranchise: "Universo Inexistente" }),
    null
  );
});

console.log(`\n${failures === 0 ? "OK" : "FALHOU"} — ${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
