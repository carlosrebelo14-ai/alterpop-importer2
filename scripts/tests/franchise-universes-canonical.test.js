#!/usr/bin/env node
/**
 * B14 (briefing backend, 24/09/2026), secção 5 — testes de canónicos.
 *
 * Nunca uma lista escrita à mão: itera FRANCHISE_UNIVERSES inteira. `name` é o valor
 * exato de alterpop.franchise e da condição EQUALS da coleção (franchiseUniverses.js,
 * cabeçalho) — tem de sair em NFC, porque a comparação de condições é por code point,
 * não por render (dois glifos visualmente iguais em NFC/NFD são strings diferentes).
 *
 * Uso: node scripts/tests/franchise-universes-canonical.test.js
 */
import assert from "node:assert/strict";
import { FRANCHISE_UNIVERSES, getUniverseByHandle } from "../../lib/importer/catalog/franchiseUniverses.js";

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

check("FRANCHISE_UNIVERSES — todas as 39 entradas têm name em NFC", () => {
  for (const u of FRANCHISE_UNIVERSES) {
    assert.equal(
      u.name,
      u.name.normalize("NFC"),
      `"${u.name}" (${u.handle}) não está em NFC — comparação de condições é por code point`
    );
  }
});

check("FRANCHISE_UNIVERSES — Pokémon usa o é pré-composto (U+00E9), não e + acento combinante (U+0301)", () => {
  const u = FRANCHISE_UNIVERSES.find((x) => x.handle === "pokemon-universe");
  assert.ok(u, "universo pokemon-universe não existe na tabela");
  assert.equal(u.name, "Pokémon");
  assert.equal(u.name.includes("́"), false);
});

check("FRANCHISE_UNIVERSES — Spy × Family usa o sinal de multiplicação U+00D7, não a letra x", () => {
  const u = FRANCHISE_UNIVERSES.find((x) => x.handle === "spy-family");
  assert.ok(u, "universo spy-family não existe na tabela");
  assert.equal(u.name, "Spy × Family");
  assert.equal(u.name.includes("Spy x Family"), false);
});

check('FRANCHISE_UNIVERSES — "The Lord of the Rings" mantém o "The"', () => {
  const u = FRANCHISE_UNIVERSES.find((x) => x.handle === "lord-of-the-rings");
  assert.ok(u, "universo lord-of-the-rings não existe na tabela");
  assert.equal(u.name, "The Lord of the Rings");
});

// ── status (B14, secção 5) ──

check("FRANCHISE_UNIVERSES — todas as entradas têm status \"open\" ou \"closed\"", () => {
  for (const u of FRANCHISE_UNIVERSES) {
    assert.ok(
      u.status === "open" || u.status === "closed",
      `"${u.name}" (${u.handle}) tem status inválido: ${JSON.stringify(u.status)}`
    );
  }
});

check("status — zelda e studio-ghibli são os dois únicos handles closed", () => {
  const closed = FRANCHISE_UNIVERSES.filter((u) => u.status === "closed").map((u) => u.handle).sort();
  assert.deepEqual(closed, ["studio-ghibli", "zelda"]);
});

check("status — os dois handles closed existem na tabela (getUniverseByHandle)", () => {
  for (const handle of ["zelda", "studio-ghibli"]) {
    const u = getUniverseByHandle(handle);
    assert.ok(u, `handle "${handle}" não existe em FRANCHISE_UNIVERSES`);
    assert.equal(u.status, "closed");
  }
});

check("status — um handle inexistente falha (getUniverseByHandle devolve null, nunca finge um universo)", () => {
  assert.equal(getUniverseByHandle("universo-que-nao-existe"), null);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nfranchise-universes-canonical: todos os casos passaram");
