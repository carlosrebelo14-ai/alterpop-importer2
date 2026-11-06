#!/usr/bin/env node
/**
 * P1 (briefing 06/11/2026). `esperado` e `obtido` do catalog_health só saem com números.
 * Uso: node scripts/tests/health-nums.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { numerosPublicaveis, linhaNums, MAX_DIGITOS_SEGUIDOS } from "../catalog/healthNums.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}

check("valores numéricos das verificações reais passam", () => {
  assert.equal(numerosPublicaveis("< 10%"), "< 10%");
  assert.equal(numerosPublicaveis("10.7% (total 23378)"), "10.7% (23378)");
  assert.equal(numerosPublicaveis("0 divergência(s)"), "0");
  assert.equal(numerosPublicaveis("70 divergência(s)"), "70");
  assert.equal(numerosPublicaveis("2319 produto(s), 41 tag(s) distinta(s)"), "2319, 41");
  assert.equal(numerosPublicaveis("0 produto(s) com tags fora da lista"), "0");
  assert.equal(numerosPublicaveis("≤ 5 produtos em drift"), "<= 5");
  assert.equal(numerosPublicaveis("3.2 pp (rácio 55.1%, 12000/23000)"), "3.2 (55.1%, 12000/23000)");
});
check("SKUs, EAN e GTIN nunca passam, sozinhos ou com palavras de contagem", () => {
  assert.equal(numerosPublicaveis("8435450233067"), null);
  assert.equal(numerosPublicaveis("889698959780"), null);
  assert.equal(numerosPublicaveis("1 produto(s) 889698959780"), null);
  assert.equal(MAX_DIGITOS_SEGUIDOS, 7);
});
check("handles, tags, GIDs e texto livre nunca passam", () => {
  for (const v of ["darth-vader", "new-arrival (2318)", "gid://shopify/Product/123", "2 corrigido(s): 889698959780.price", "falhou", "ok", "—", null, undefined, ""]) {
    assert.equal(numerosPublicaveis(v), null, String(v));
  }
});
check("linhaNums só existe para vermelhas e amarelas e usa n/d quando não há números", () => {
  assert.equal(linhaNums({ id: "V3", level: "pass", expected: 0, actual: 0 }), null);
  assert.equal(linhaNums({ id: "V5", level: "fail", expected: "< 10%", actual: "10.7% (total 23378)" }), "NUMS: V5 nivel=fail esperado=< 10% obtido=10.7% (23378)");
  assert.equal(linhaNums({ id: "V14", level: "warn", expected: "todas open publicadas", actual: "publicou 3 (handle-a)" }), "NUMS: V14 nivel=warn esperado=n/d obtido=n/d");
});
check("pre-pilot-verify imprime a linha NUMS de cada vermelha e amarela (estático)", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/catalog/pre-pilot-verify.js"), "utf8");
  assert.ok(src.includes('import { linhaNums } from "./healthNums.js";'));
  assert.ok(/for \(const r of results\) \{\s*const linha = linhaNums\(r\);\s*if \(linha\) console\.log\(linha\);/.test(src));
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nhealth-nums: todos os testes passaram");
