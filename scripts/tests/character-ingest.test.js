#!/usr/bin/env node
/**
 * ADENDA 3 (briefing backend, 17/09/2026) — resolvedCharacters recalculado no ingest
 * (toLiteProduct), como resolvedFormat/cleanTitle. Sem isto os produtos novos do feed
 * ficam sem Character até ao próximo backfill manual.
 * Uso: node scripts/tests/character-ingest.test.js
 */
import assert from "node:assert/strict";
import { toLiteProduct } from "../../lib/importer/catalog/catalogProducts.server.js";

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

check("toLiteProduct calcula resolvedCharacters (Luffy, One Piece)", () => {
  const p = toLiteProduct({
    sku: "1",
    title: "One Piece Monkey.D.Luffy Grandline Series",
    franchiseRefs: ["One Piece"],
  });
  assert.equal(p.resolvedFranchise, "One Piece");
  assert.deepEqual(JSON.parse(p.resolvedCharacters), ["luffy"]);
});

check("toLiteProduct calcula vários handles, na ordem do título (Star Wars)", () => {
  const p = toLiteProduct({
    sku: "2",
    title: "Star Wars Luke Skywalker & Grogu",
    franchiseRefs: ["Star Wars"],
  });
  assert.equal(p.resolvedFranchise, "Star Wars");
  assert.deepEqual(JSON.parse(p.resolvedCharacters), ["luke-skywalker", "grogu"]);
});

check("toLiteProduct sem Character -> resolvedCharacters null", () => {
  const p = toLiteProduct({
    sku: "3",
    title: "Frozen blanket 100x150cm",
    franchiseRefs: ["Frozen"],
  });
  assert.equal(p.resolvedFranchise, "Frozen");
  assert.equal(p.resolvedCharacters, null);
});

check("toLiteProduct sem franquia resolvida -> resolvedCharacters null", () => {
  const p = toLiteProduct({ sku: "4", title: "Genérico sem franquia nenhuma", franchiseRefs: [] });
  assert.equal(p.resolvedFranchise, null);
  assert.equal(p.resolvedCharacters, null);
});

console.log(`\n${failures === 0 ? "OK" : "FALHOU"} — ${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
