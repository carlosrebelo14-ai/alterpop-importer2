#!/usr/bin/env node
/**
 * PR 4b — classes autorizadas do cycle-apply-once (27/10/2026). Uso: node scripts/tests/character-cycle-allowlist.test.js
 */
import assert from "node:assert/strict";
import { classificarAcoesAutorizadas } from "../../lib/importer/catalog/characterCycleAllowlist.js";

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

const a = (action, handle) => ({ action, handle, count: 1 });

check("classes autorizadas passam", () => {
  const r = classificarAcoesAutorizadas([
    a("reactivate", "darth-vader"),
    a("reactivate", "grogu"),
    a("reactivate", "luke-skywalker"),
    a("create", "ahsoka-tano"),
    a("create", "legolas"),
    a("update", "frodo"),
    a("set-draft", "luffy"),
    a("set-draft", "goku"),
    a("set-draft", "vegeta"),
  ]);
  assert.equal(r.fora.length, 0);
  assert.equal(r.permitidas.length, 9);
});

check("uma ação fora das classes aborta: create de nome fora da D3", () => {
  const r = classificarAcoesAutorizadas([a("create", "batman"), a("update", "frodo")]);
  assert.deepEqual(r.fora.map((f) => f.handle), ["batman"]);
});

check("reativar um personagem fora da lista fica de fora", () => {
  const r = classificarAcoesAutorizadas([a("reactivate", "frodo")]);
  assert.equal(r.fora.length, 1);
});

check("set-draft fora de luffy, goku e vegeta fica de fora", () => {
  const r = classificarAcoesAutorizadas([a("set-draft", "frodo")]);
  assert.equal(r.fora.length, 1);
});

check("skip e error não contam", () => {
  const r = classificarAcoesAutorizadas([a("skip", "batman"), a("error", "frodo")]);
  assert.equal(r.fora.length, 0);
  assert.equal(r.permitidas.length, 0);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
