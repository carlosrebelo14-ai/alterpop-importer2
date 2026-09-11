#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 34 (Decisão 18) — formatExtractor.server.js.
 * Uso: node scripts/tests/format-extractor.test.js
 */
import assert from "node:assert/strict";
import { extractProductFormat } from "../../lib/importer/catalog/formatExtractor.server.js";

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

check("POP figure → Figure", () => {
  assert.equal(extractProductFormat({ title: "POP figure One Piece Luffy" }), "Figure");
});

check("Pocket POP Keychain → Keychain (Keychain vence Figure, mais específico)", () => {
  assert.equal(extractProductFormat({ title: "Pocket POP Keychain Batman" }), "Keychain");
});

check("Loungefly backpack → Backpack", () => {
  assert.equal(extractProductFormat({ title: "Loungefly Disney Cars Mystery Blind Box Enamel Pins" }), "Backpack");
});

check("puzzle → Puzzle", () => {
  assert.equal(extractProductFormat({ title: "Minecraft puzzle 3D 54pcs" }), "Puzzle");
});

check("plush toy → Plush", () => {
  assert.equal(extractProductFormat({ title: "Care Bears Good Luck Bear plush toy 35cm" }), "Plush");
});

check("mug → Mug", () => {
  assert.equal(extractProductFormat({ title: "Rick and Morty Retro Poster mug" }), "Mug");
});

check("sem sinal nenhum → null", () => {
  assert.equal(extractProductFormat({ title: "Form Words game" }), null);
  assert.equal(extractProductFormat({}), null);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nformat-extractor: todos os casos passaram");
