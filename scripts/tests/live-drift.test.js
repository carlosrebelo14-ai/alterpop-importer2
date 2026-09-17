#!/usr/bin/env node
/**
 * LIVE_DRIFT (ADENDA 5, briefing backend, 17/09/2026) — liveDrift.server.js.
 * Uso: node scripts/tests/live-drift.test.js
 */
import assert from "node:assert/strict";
import { computeLiveDrift } from "../../lib/importer/curation/liveDrift.server.js";

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

check("tudo igual → sem findings", () => {
  const payload = {
    resolvedFranchise: "Star Wars",
    resolvedLine: "The Mandalorian",
    resolvedFormat: "Figure",
    resolvedManufacturerLine: "Ultimate",
  };
  const live = { franchise: "Star Wars", line: "The Mandalorian", format: "Figure", manufacturer_line: "Ultimate" };
  assert.deepEqual(computeLiveDrift(payload, live), []);
});

check("tudo null nos dois lados → sem findings (ausente é o correto, não um drift)", () => {
  assert.deepEqual(computeLiveDrift({}, {}), []);
});

check("caso real · SKU 4983164896497 — format esperado 'Figure', live vazio (R2)", () => {
  const payload = { resolvedFranchise: "One Piece", resolvedFormat: "Figure" };
  const live = { franchise: "One Piece", format: null };
  const findings = computeLiveDrift(payload, live);
  assert.deepEqual(findings, [{ code: "LIVE_DRIFT", field: "format", live: null, expected: "Figure" }]);
});

check("caso real · SKU 889698835947 — format esperado 'Figure', live vazio (R1)", () => {
  const payload = { resolvedFranchise: "Star Wars", resolvedFormat: "Figure" };
  const live = { franchise: "Star Wars", format: null };
  const findings = computeLiveDrift(payload, live);
  assert.deepEqual(findings, [{ code: "LIVE_DRIFT", field: "format", live: null, expected: "Figure" }]);
});

check("caso real · SKU 0192995218383 — format esperado 'Doll' (D2), live vazio", () => {
  const payload = { resolvedFranchise: null, resolvedFormat: "Doll" };
  const live = { franchise: null, format: null };
  const findings = computeLiveDrift(payload, live);
  assert.deepEqual(findings, [{ code: "LIVE_DRIFT", field: "format", live: null, expected: "Doll" }]);
});

check("manufacturer_line em drift, os outros três batem", () => {
  const payload = {
    resolvedFranchise: "Dragon Ball",
    resolvedLine: null,
    resolvedFormat: "Figure",
    resolvedManufacturerLine: "S.H.Figuarts",
  };
  const live = { franchise: "Dragon Ball", line: null, format: "Figure", manufacturer_line: "Robot Spirits" };
  const findings = computeLiveDrift(payload, live);
  assert.deepEqual(findings, [
    { code: "LIVE_DRIFT", field: "manufacturer_line", live: "Robot Spirits", expected: "S.H.Figuarts" },
  ]);
});

check("vários campos em drift ao mesmo tempo — cada um o seu finding, ordem de LIVE_DRIFT_FIELDS", () => {
  const payload = { resolvedFranchise: "Star Wars", resolvedFormat: "Figure" };
  const live = { franchise: null, format: null };
  const findings = computeLiveDrift(payload, live);
  assert.deepEqual(findings, [
    { code: "LIVE_DRIFT", field: "franchise", live: null, expected: "Star Wars" },
    { code: "LIVE_DRIFT", field: "format", live: null, expected: "Figure" },
  ]);
});

check("live tem valor que o Prisma já não espera (o inverso do caso comum)", () => {
  const payload = { resolvedFormat: null };
  const live = { format: "Figure" };
  const findings = computeLiveDrift(payload, live);
  assert.deepEqual(findings, [{ code: "LIVE_DRIFT", field: "format", live: "Figure", expected: null }]);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nlive-drift: todos os casos passaram");
