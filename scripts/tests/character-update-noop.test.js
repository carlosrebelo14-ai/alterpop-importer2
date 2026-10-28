#!/usr/bin/env node
/* eslint-env node */
/**
 * Update sem mudança (29/10/2026): um Character ACTIVE cujos campos já batem com a loja
 * é "noop", não "update". Ordem de products/universe não conta. Puro, sem Shopify.
 * Uso: node scripts/tests/character-update-noop.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "character-update-noop-unused.sqlite")}`;
const { updateSemMudanca, marcarUpdatesSemMudanca, diffCharacterFieldLines } = await import(
  path.join(process.cwd(), "lib/importer/shopify/characterPagesSync.server.js")
);

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

const UNI_A = "gid://shopify/Collection/1";
const UNI_B = "gid://shopify/Collection/2";
const P1 = "gid://shopify/Product/10";
const P2 = "gid://shopify/Product/20";

const campos = (products, universe, title = "Luffy") =>
  new Map([
    ["title", title],
    ["universe", JSON.stringify(universe)],
    ["products", JSON.stringify(products)],
  ]);

const seguinte = (products, universe, title = "Luffy") => [
  { key: "title", value: title },
  { key: "universe", value: JSON.stringify(universe) },
  { key: "products", value: JSON.stringify(products) },
];

check("campos iguais são noop", () => {
  assert.equal(updateSemMudanca(campos([P1, P2], [UNI_A]), seguinte([P1, P2], [UNI_A])), true);
});

check("ordem diferente de products não é mudança", () => {
  assert.equal(updateSemMudanca(campos([P1, P2], [UNI_A]), seguinte([P2, P1], [UNI_A])), true);
});

check("ordem diferente de universe não é mudança", () => {
  assert.equal(updateSemMudanca(campos([P1], [UNI_A, UNI_B]), seguinte([P1], [UNI_B, UNI_A])), true);
});

check("produto novo é mudança", () => {
  assert.equal(updateSemMudanca(campos([P1], [UNI_A]), seguinte([P1, P2], [UNI_A])), false);
});

check("produto removido é mudança", () => {
  assert.equal(updateSemMudanca(campos([P1, P2], [UNI_A]), seguinte([P1], [UNI_A])), false);
});

check("título mudado é mudança", () => {
  assert.equal(updateSemMudanca(campos([P1], [UNI_A], "Luffy"), seguinte([P1], [UNI_A], "Monkey D. Luffy")), false);
});

check("metaobject sem campos nunca é noop", () => {
  assert.equal(updateSemMudanca(undefined, seguinte([P1], [UNI_A])), false);
});

check("valor antigo inválido conta como vazio (mudança)", () => {
  const prev = new Map([
    ["title", "Luffy"],
    ["universe", "não é json"],
    ["products", JSON.stringify([P1])],
  ]);
  assert.equal(updateSemMudanca(prev, seguinte([P1], [UNI_A])), false);
});

check("diff de log não lista ordem trocada", () => {
  assert.deepEqual(diffCharacterFieldLines("luffy", campos([P1, P2], [UNI_A]), seguinte([P2, P1], [UNI_A])), []);
});

const planoUpdate = (handle, universos, nome = "Luffy") => ({ handle, nome, action: "update", universos, targetStatus: "ACTIVE" });

check("marcar: update igual vira noop, update com produto novo fica update", () => {
  const existing = new Map([
    ["luffy", { id: "gid://mo/1", status: "ACTIVE", fields: campos([P1, P2], [UNI_A]) }],
    ["zoro", { id: "gid://mo/2", status: "ACTIVE", fields: campos([P1], [UNI_A], "Zoro") }],
  ]);
  const liveCounts = new Map([
    ["luffy", { productIds: [P2, P1] }],
    ["zoro", { productIds: [P1, P2] }],
  ]);
  const uniGid = new Map([[ "Universo A", UNI_A ]]);
  const out = marcarUpdatesSemMudanca(
    [planoUpdate("luffy", ["Universo A"]), planoUpdate("zoro", ["Universo A"], "Zoro")],
    existing,
    liveCounts,
    uniGid,
  );
  assert.equal(out[0].action, "noop");
  assert.equal(out[1].action, "update");
});

check("marcar: create e set-draft não são tocados", () => {
  const actions = [
    { handle: "x", action: "create", targetStatus: "ACTIVE" },
    { handle: "y", action: "set-draft", targetStatus: "DRAFT" },
  ];
  const out = marcarUpdatesSemMudanca(actions, new Map(), new Map(), new Map());
  assert.deepEqual(out.map((a) => a.action), ["create", "set-draft"]);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nok: character-update-noop");
