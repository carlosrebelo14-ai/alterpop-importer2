#!/usr/bin/env node
/* eslint-env node */
/**
 * Lote 1 (Decisão 34), DBG-03 e DBG-11:
 *   - só se publica o que está APPROVED: um SKU pedido fora de APPROVED recusa o pedido inteiro,
 *     com a lista de SKUs e estados, e não há fallback que publique o pedido na mesma;
 *   - aprovar manualmente um produto PUBLISHED é recusado (erro com código APPROVE_PUBLISHED).
 * Lógica pura em resolveSyncSkus.js e approvalGuard.js; os fallbacks removidos têm guarda de texto.
 * Uso: node scripts/tests/approved-only-sync.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSyncSkus } from "../../lib/importer/shopify/resolveSyncSkus.js";
import { assertApprovable, ApprovePublishedError } from "../../lib/curation/approvalGuard.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

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

console.log("resolveSyncSkus — DBG-03");
const approved = ["A1", "A2", "A3"];
const statuses = new Map([
  ["A1", "APPROVED"],
  ["A2", "APPROVED"],
  ["A3", "APPROVED"],
  ["P1", "PENDING"],
  ["R1", "REJECTED"],
  ["PUB1", "PUBLISHED"],
]);

check("sem pedido → todos os APPROVED, pela ordem da fila", () => {
  assert.deepEqual(resolveSyncSkus({ requested: null, approved, statusBySku: statuses }), { ok: true, skus: approved });
  assert.deepEqual(resolveSyncSkus({ requested: [], approved, statusBySku: statuses }), { ok: true, skus: approved });
});

check("pedido só de APPROVED → aceite, pela ordem da fila", () => {
  const r = resolveSyncSkus({ requested: ["A3", "A1"], approved, statusBySku: statuses });
  assert.deepEqual(r, { ok: true, skus: ["A1", "A3"] });
});

check("SKU PENDING pedido → recusado, sem skus, com estado na lista", () => {
  const r = resolveSyncSkus({ requested: ["A1", "P1"], approved, statusBySku: statuses });
  assert.equal(r.ok, false);
  assert.equal("skus" in r, false);
  assert.deepEqual(r.rejected, [{ sku: "P1", status: "PENDING" }]);
  assert.match(r.error, /P1 \(PENDING\)/);
  assert.match(r.error, /Nada foi publicado/);
});

check("SKU REJECTED ou PUBLISHED pedido → recusado (nunca publicado por fallback)", () => {
  const r = resolveSyncSkus({ requested: ["R1", "PUB1"], approved, statusBySku: statuses });
  assert.equal(r.ok, false);
  assert.deepEqual(r.rejected, [
    { sku: "R1", status: "REJECTED" },
    { sku: "PUB1", status: "PUBLISHED" },
  ]);
});

check("SKU sem entrada na fila → recusado com estado null", () => {
  const r = resolveSyncSkus({ requested: ["NOVO"], approved, statusBySku: statuses });
  assert.equal(r.ok, false);
  assert.deepEqual(r.rejected, [{ sku: "NOVO", status: null }]);
  assert.match(r.error, /NOVO \(sem entrada na fila\)/);
});

check("mistura APPROVED e PENDING → recusa o pedido inteiro (não publica a parte aprovada)", () => {
  const r = resolveSyncSkus({ requested: ["A1", "A2", "P1"], approved, statusBySku: statuses });
  assert.equal(r.ok, false);
  assert.equal(r.rejected.length, 1);
});

check("duplicados no pedido não contam duas vezes", () => {
  const r = resolveSyncSkus({ requested: ["A1", "A1", "P1", "P1"], approved, statusBySku: statuses });
  assert.equal(r.rejected.length, 1);
  assert.match(r.error, /^1 SKU\(s\)/);
});

console.log("assertApprovable — DBG-11");
check("PUBLISHED → lança ApprovePublishedError com código APPROVE_PUBLISHED", () => {
  assert.throws(
    () => assertApprovable({ sku: "PUB1", status: "PUBLISHED" }),
    (err) => err instanceof ApprovePublishedError && err.code === "APPROVE_PUBLISHED" && err.sku === "PUB1"
  );
});

check("PENDING, REJECTED, APPROVED, SYNC_ERROR e SKU nova não lançam", () => {
  for (const status of ["PENDING", "REJECTED", "APPROVED", "SYNC_ERROR"]) {
    assert.doesNotThrow(() => assertApprovable({ sku: "X", status }), status);
  }
  assert.doesNotThrow(() => assertApprovable(null));
  assert.doesNotThrow(() => assertApprovable(undefined));
});

console.log("ligação ao código real — sem os fallbacks e com a guarda");
const route = read("app/routes/api.shopify-sync.jsx");
const engine = read("lib/importer/shopify/shopifyApprovedSync.server.js");
const approveRoute = read("app/routes/api.curation.queue.$sku.approve.jsx");
const queue = read("lib/curation/curationQueue.server.js");

check("route sem o fallback approvedSkus = requestedSkus", () => {
  assert.doesNotMatch(route, /approvedSkus = requestedSkus/);
  assert.match(route, /resolveSyncSkus\(\{ requested: requestedSkus/);
});

check("motor sem o fallback uniqueSkus = [...requestedSet]", () => {
  assert.doesNotMatch(engine, /uniqueSkus = \[\.\.\.requestedSet\]/);
  assert.match(engine, /resolveSyncSkus\(\{ requested: opts\.skus/);
});

check("aprovação recusa PUBLISHED: a guarda corre antes de gravar", () => {
  assert.match(queue, /assertApprovable\(item\);/);
  assert.match(approveRoute, /err\?\.code === "APPROVE_PUBLISHED"[\s\S]*status: 409/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\napproved-only-sync: todos os casos passaram");
