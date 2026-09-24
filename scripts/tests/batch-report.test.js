#!/usr/bin/env node
/**
 * B14 (briefing backend, 24/09/2026) — lib/maintenance/batchReport.js.
 * Caso real: collection-description-clean.js e collection-publication-sync.js
 * reportaram processed=0 total=0 com itens lidos — este teste falha se o defeito voltar.
 * Uso: node scripts/tests/batch-report.test.js
 */
import assert from "node:assert/strict";
import { checkBatchCounts } from "../../lib/maintenance/batchReport.js";

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

check("checkBatchCounts — falha com processed=0 total=0 e itens lidos (caso real: 35 lidos, 0 por publicar)", () => {
  const result = checkBatchCounts({ itemsRead: 35, processed: 0, total: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /35 item\(ns\) lido\(s\)/);
});

check("checkBatchCounts — falha com total=0 mesmo que processed não seja 0", () => {
  const result = checkBatchCounts({ itemsRead: 10, processed: 3, total: 0 });
  assert.equal(result.ok, false);
});

check("checkBatchCounts — ok quando processed=total=itemsRead", () => {
  assert.equal(checkBatchCounts({ itemsRead: 35, processed: 35, total: 35 }).ok, true);
});

check("checkBatchCounts — ok com itemsRead=0 (loja vazia é um estado legítimo)", () => {
  assert.equal(checkBatchCounts({ itemsRead: 0, processed: 0, total: 0 }).ok, true);
});

check("checkBatchCounts — falha se processed != total, mesmo os dois > 0", () => {
  const result = checkBatchCounts({ itemsRead: 35, processed: 34, total: 35 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /processed \(34\) != total \(35\)/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nbatch-report: todos os casos passaram");
