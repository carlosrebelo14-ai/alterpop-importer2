#!/usr/bin/env node
/**
 * Export CSV: acima do limite recusa com mensagem, em vez de cortar em silêncio.
 * Uso: node scripts/tests/export-limit.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPORT_LIMIT, exportLimitMessage } from "../../lib/curation/exportLimit.js";

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

check("o limite é 5000", () => assert.equal(EXPORT_LIMIT, 5000));
check("até 5000 cabe, sem mensagem", () => {
  assert.equal(exportLimitMessage(0), null);
  assert.equal(exportLimitMessage(5000), null);
});
check("5001 e 13 016 recusam, com o total e o limite na mensagem", () => {
  assert.ok(exportLimitMessage(5001));
  const m = exportLimitMessage(13016);
  assert.match(m, /^O filtro tem 13 016 produtos e a exportação aceita até 5 000\. Restringe o filtro\./);
});
check("total desconhecido (NaN/undefined) não recusa por engano", () => {
  assert.equal(exportLimitMessage(undefined), null);
  assert.equal(exportLimitMessage(NaN), null);
});
check("a rota recusa ANTES de construir o CSV, com 413 e a mensagem", () => {
  const src = fs.readFileSync(path.join(ROOT, "app/routes/api.products.export.jsx"), "utf8");
  const refuseAt = src.indexOf("exportLimitMessage(result.totalCount)");
  const csvAt = src.indexOf("buildCsv(");
  assert.ok(refuseAt > 0, "não chama exportLimitMessage");
  assert.ok(csvAt > refuseAt, "constrói o CSV antes de recusar");
  assert.match(src, /status: 413/);
  assert.ok(!/const EXPORT_LIMIT = 5000/.test(src), "duplicou o limite");
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
