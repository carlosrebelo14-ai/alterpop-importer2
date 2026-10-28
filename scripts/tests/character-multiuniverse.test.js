#!/usr/bin/env node
/**
 * Vários universos por personagem (decisão do arquiteto, 28/10/2026). Magneto liga-se a X-Men e a
 * Avengers. O metaobject leva a lista dos dois universos, entra nas duas coleções e I3 fica verde.
 * Uso: node scripts/tests/character-multiuniverse.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { planCharacterMetaobjects, planUniverseCharacterCollections, buildCharacterCatalog } from "../../lib/importer/catalog/characterPages.server.js";
import { checkCharacterInvariants } from "../../lib/importer/catalog/characterInvariants.js";
import { resolveCharacters } from "../../lib/importer/catalog/characterResolver.server.js";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "multiuniverse-unused.sqlite")}`;
const { liveCountsFromLinks } = await import("../../lib/importer/shopify/characterPagesSync.server.js");

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

const ativos = [
  { id: "P1", sku: "S1" },
  { id: "P2", sku: "S2" },
];
const ligacoes = new Map([
  ["S1", [{ handle: "magneto", universeHandle: "x-men" }]],
  ["S2", [{ handle: "magneto", universeHandle: "avengers" }]],
]);
const franquias = new Map([
  ["S1", "X-Men"],
  ["S2", "Avengers"],
]);

check("resolver: magneto em títulos de X-Men e de Avengers", () => {
  assert.deepEqual(resolveCharacters({ originalTitle: "X-Men Magneto figure", resolvedFranchise: "X-Men" }), ["magneto"]);
  assert.deepEqual(resolveCharacters({ originalTitle: "Avengers Magneto figure", resolvedFranchise: "Avengers" }), ["magneto"]);
});

check("catálogo: magneto tem os dois universos do vocabulário", () => {
  const m = buildCharacterCatalog().get("magneto");
  assert.ok(m.universos.includes("X-Men") && m.universos.includes("Avengers"), JSON.stringify(m.universos));
});

check("ligações: universos = união dos universeHandle das ligações", () => {
  const live = liveCountsFromLinks(ativos, ligacoes, franquias);
  assert.deepEqual([...live.get("magneto").universos].sort(), ["Avengers", "X-Men"]);
  assert.deepEqual(live.get("magneto").productSkus.sort(), ["S1", "S2"]);
});

check("metaobject leva a lista completa de universos", () => {
  const live = liveCountsFromLinks(ativos, ligacoes, franquias);
  const [a] = planCharacterMetaobjects({ liveCounts: live, existing: new Map() }).filter((x) => x.handle === "magneto");
  assert.equal(a.action, "create");
  assert.deepEqual([...a.universos].sort(), ["Avengers", "X-Men"]);
});

check("coleções: magneto entra em alterpop.characters dos dois universos", () => {
  const live = liveCountsFromLinks(ativos, ligacoes, franquias);
  const plan = planUniverseCharacterCollections(planCharacterMetaobjects({ liveCounts: live, existing: new Map() }));
  assert.ok(plan.get("X-Men").includes("magneto"));
  assert.ok(plan.get("Avengers").includes("magneto"));
});

check("I3 verde nos dois universos", () => {
  const r = checkCharacterInvariants({
    characters: new Map([["magneto", { status: "ACTIVE", universes: ["X-Men", "Avengers"], products: ["S1", "S2"] }]]),
    products: [
      { sku: "S1", status: "ACTIVE", published: true, franchise: "X-Men", vendor: "Hasbro", characters: ["magneto"] },
      { sku: "S2", status: "ACTIVE", published: true, franchise: "Avengers", vendor: "Hasbro", characters: ["magneto"] },
    ],
    universeCharacters: new Map([["X-Men", ["magneto"]], ["Avengers", ["magneto"]]]),
    canonicalVendors: new Set(["Hasbro"]),
  });
  assert.equal(r.red.filter((x) => x.id === "I3").length, 0, JSON.stringify(r.red));
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
