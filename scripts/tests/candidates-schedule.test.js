#!/usr/bin/env node
/* eslint-env node */
/**
 * Rotina de candidatos (decisão do arquiteto, 28/10/2026): só leitura, environment production-read,
 * sem --execute, com --novos-min 2. Uso: node scripts/tests/candidates-schedule.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/candidates-schedule.yml"), "utf8");
const script = fs.readFileSync(path.join(ROOT, "scripts/catalog/character-candidates.js"), "utf8");

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

check("a rotina corre em production-read", () => {
  assert.match(yml, /environment: production-read/);
  assert.doesNotMatch(yml, /environment: production\s*$/m);
});

check("a rotina nunca escreve (sem --execute)", () => {
  assert.doesNotMatch(yml, /--execute/);
});

check("a rotina só mostra novos com 2 ou mais produtos", () => {
  assert.match(yml, /--novos-min 2/);
});

check("o script só reporta novos com --novos-min (vocabulário e abaixo do mínimo saem)", () => {
  assert.match(script, /NOVOS_MIN && \(estado !== "novo" \|\| e\.total < NOVOS_MIN\)/);
});

check("dia sem novos não produz artefacto (upload condicionado a novos=sim)", () => {
  assert.match(yml, /if: steps\.candidatos\.outputs\.novos == 'sim'/);
  assert.match(yml, /novos=nao/);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
