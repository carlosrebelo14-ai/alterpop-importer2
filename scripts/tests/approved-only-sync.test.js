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
import { assertApprovable, assertTransitionAllowed, ApprovePublishedError } from "../../lib/curation/approvalGuard.js";
import { partitionPublishSelection, describeLeftOut } from "../../lib/curation/publishSelection.js";

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
  assert.match(queue, /let item = queue\.items\.find\(\(i\) => i\.sku === sku\);\s*\n\s*\/\/[^\n]*\n\s*assertApprovable\(item\);/);
  assert.match(approveRoute, /if \(err\?\.code === "APPROVE_PUBLISHED"\) \{\s*\n\s*return Response\.json\(\{ ok: false, error: err\.message \}, \{ status: 409 \}\);/);
});
check("aprovação em modo degradado responde 503 com a causa, não 404", () => {
  assert.match(approveRoute, /if \(err\?\.code === "DB_DEGRADED"\) \{[\s\S]*?status: 503/);
});
check("skus que não é lista recusa com 400 (antes lia-se como ausente)", () => {
  assert.match(route, /skusInvalidos = true/);
  assert.match(route, /if \(skusInvalidos && !isCancel\)/);
});
check("motor falha o job quando recusa SKUs, para não ficar em running", () => {
  assert.match(engine, /if \(!resolved\.ok\) \{[\s\S]*?await failShopifySyncJob\(shop, resolved\.error\)/);
});
check("painel lê a fila por loadCurationQueueForPanel e o resumo usa o mesmo conjunto que publica", () => {
  const ui = read("app/routes/app._index.jsx");
  assert.match(ui, /const \{ queue: curationQueue \} = await loadCurationQueueForPanel\(\);/);
  assert.match(ui, /new URLSearchParams\(\{ skus: publishSkus\.join\(","\) \}\)/);
});

console.log("assertTransitionAllowed — DBG-11, setter em massa");
check("lote com PUBLISHED para APPROVED → lança com a lista de todos", () => {
  assert.throws(
    () => assertTransitionAllowed([{ sku: "A", status: "PENDING" }, { sku: "B", status: "PUBLISHED" }, { sku: "C", status: "PUBLISHED" }], "APPROVED"),
    (err) => err.code === "APPROVE_PUBLISHED" && err.skus.join() === "B,C" && /2 SKU\(s\)/.test(err.message)
  );
});
check("lote com PUBLISHED para PENDING ou REJECTED → permitido (revert)", () => {
  assert.doesNotThrow(() => assertTransitionAllowed([{ sku: "B", status: "PUBLISHED" }], "PENDING"));
  assert.doesNotThrow(() => assertTransitionAllowed([{ sku: "B", status: "PUBLISHED" }], "REJECTED"));
});

console.log("partitionPublishSelection — DBG-03, painel");
const decisions = { A1: "APPROVED", A2: "APPROVED", P1: "PENDING", R1: "REJECTED", PUB1: "PUBLISHED" };
check("só APPROVED vai para publicar; o resto é contado por estado", () => {
  const p = partitionPublishSelection(["A1", "P1", "PUB1", "R1", "A2", "NOVO"], decisions);
  assert.deepEqual(p.publish, ["A1", "A2"]);
  assert.equal(p.leftOutCount, 4);
  assert.deepEqual(p.leftOut, { PENDING: 1, PUBLISHED: 1, REJECTED: 1, "sem decisão": 1 });
  assert.equal(describeLeftOut(p.leftOut), "1 PENDING, 1 PUBLISHED, 1 REJECTED, 1 sem decisão");
});
check("seleção toda APPROVED → nada de fora", () => {
  const p = partitionPublishSelection(["A1", "A2"], decisions);
  assert.deepEqual(p.publish, ["A1", "A2"]);
  assert.equal(p.leftOutCount, 0);
  assert.equal(describeLeftOut(p.leftOut), "");
});
check("seleção sem nenhum APPROVED → publish vazio (o painel não envia lista vazia)", () => {
  const p = partitionPublishSelection(["P1", "R1"], decisions);
  assert.deepEqual(p.publish, []);
  assert.equal(p.leftOutCount, 2);
});

console.log("ligação ao código real — DBG-03, DBG-22 e painel");
check("route recusa skus: [] (lia-se como todos os APPROVED)", () => {
  assert.match(route, /skusVazios = requestedSkus\.length === 0/);
  assert.match(route, /if \(skusVazios && !isCancel\)/);
});
check("painel envia só publishSkus e conta com a mesma lista", () => {
  const ui = read("app/routes/app._index.jsx");
  assert.match(ui, /partitionPublishSelection\(selectedSkus, decisions\)/);
  assert.match(ui, /skus: publishSkus,\s*confirmCount: publishSkus\.length/);
  assert.match(ui, /publishCount=\{publishSkus\.length\}/);
  assert.doesNotMatch(ui, /skus: selectedSkus\.length > 0 \? selectedSkus : approvedSkus/);
  assert.match(ui, /if \(publishSkus\.length === 0\)/);
});
check("DBG-22: a fila que não recupera já não é reiniciada; grava a flag e lança", () => {
  assert.doesNotMatch(queue, /resetCorruptedQueueToEmpty/);
  assert.match(queue, /async function degradeUnrecoverableQueue/);
  assert.match(queue, /markDbDegraded\(/);
  assert.match(queue, /throw new DbDegradedError\("leitura da fila de curadoria"/);
});
check("setter em massa tem a guarda antes de mutar", () => {
  assert.match(queue, /assertTransitionAllowed\(\s*queue\.items\.filter/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\napproved-only-sync: todos os casos passaram");
