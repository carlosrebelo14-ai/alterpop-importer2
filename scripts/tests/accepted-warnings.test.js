#!/usr/bin/env node
/**
 * ADENDA 8 (briefing backend, 17/09/2026) — acceptedWarnings.js.
 * Uso: node scripts/tests/accepted-warnings.test.js
 */
import assert from "node:assert/strict";
import { isWarningAccepted, ACCEPTED_WARNINGS } from "../../lib/importer/curation/acceptedWarnings.js";

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

check("caso real · os dois Luke Skywalker estão aceites para TITLE_DUPLICATE", () => {
  assert.equal(isWarningAccepted("889698675369", "TITLE_DUPLICATE"), true);
  assert.equal(isWarningAccepted("889698837972", "TITLE_DUPLICATE"), true);
});

check("um aviso aceite não conta — mesmo par SKU+código", () => {
  assert.equal(isWarningAccepted("889698675369", "TITLE_DUPLICATE"), true);
});

check("o mesmo código noutro SKU continua a contar — aceitar um par nunca desliga a verificação", () => {
  assert.equal(isWarningAccepted("0000000000000", "TITLE_DUPLICATE"), false);
});

check("o mesmo SKU aceite, código diferente, continua a contar", () => {
  assert.equal(isWarningAccepted("889698675369", "MISSING_FORMAT"), false);
});

check("SKU/código desconhecidos nunca contam como aceites", () => {
  assert.equal(isWarningAccepted("", ""), false);
  assert.equal(isWarningAccepted(undefined, undefined), false);
});

check("ACCEPTED_WARNINGS tem exatamente os dois pares da ADENDA 8, nada mais escondido", () => {
  assert.deepEqual(
    ACCEPTED_WARNINGS.map((w) => `${w.sku}.${w.code}`).sort(),
    ["889698675369.TITLE_DUPLICATE", "889698837972.TITLE_DUPLICATE"]
  );
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\naccepted-warnings: todos os casos passaram");
