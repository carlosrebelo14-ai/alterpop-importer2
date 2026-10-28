#!/usr/bin/env node
/* eslint-env node */
/**
 * Log do ciclo de personagens (28/10/2026): valor anterior de cada campo escrito, diff por personagem.
 * Puro: diffCharacterFieldLines não toca na Shopify. Uso: node scripts/tests/character-field-log.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "character-field-log-unused.sqlite")}`;
const { diffCharacterFieldLines } = await import(path.join(process.cwd(), "lib/importer/shopify/characterPagesSync.server.js"));

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

check("campo igual não gera linha", () => {
  const lines = diffCharacterFieldLines("luffy", new Map([["title", "Luffy"]]), [{ key: "title", value: "Luffy" }]);
  assert.deepEqual(lines, []);
});

check("universe mudado mostra antes, depois e o diff de gids", () => {
  const lines = diffCharacterFieldLines(
    "luffy",
    new Map([["universe", '["gid://a"]']]),
    [{ key: "universe", value: '["gid://a","gid://b"]' }],
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /luffy · universe: antes=\["gid:\/\/a"\] · depois=\["gid:\/\/a","gid:\/\/b"\] · \+1 -0/);
});

check("products com removidos e adicionados conta os dois lados", () => {
  const lines = diffCharacterFieldLines(
    "grogu",
    new Map([["products", '["p1","p2"]']]),
    [{ key: "products", value: '["p2","p3"]' }],
  );
  assert.match(lines[0], /\+1 -1$/);
});

check("metaobject novo marca a criação e lista os campos", () => {
  const lines = diffCharacterFieldLines("yoda", undefined, [{ key: "title", value: "Yoda" }]);
  assert.equal(lines[0], "  yoda · metaobject novo");
  assert.match(lines[1], /yoda · title: antes=\(vazio\) · depois=Yoda/);
});

check("valor antigo que não é lista JSON não rebenta (conta como vazio)", () => {
  const lines = diffCharacterFieldLines("ahsoka-tano", new Map([["universe", "lixo"]]), [{ key: "universe", value: '["gid://a"]' }]);
  assert.match(lines[0], /\+1 -0$/);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
