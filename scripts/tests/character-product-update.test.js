#!/usr/bin/env node
/* eslint-env node */
/**
 * product-update (29/10/2026): o ciclo corrige alterpop.character do produto a partir de ProductCharacter.
 * Caso real: ligação trocada de yoda para grogu. O metaobject já tinha o produto fora, mas o produto
 * ficou com a etiqueta yoda. Tem de sair com grogu. Puro + um cliente falso que só regista metafieldsSet.
 * Uso: node scripts/tests/character-product-update.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "character-product-update-unused.sqlite")}`;
const { planProductCharacterUpdates, applyCharacterActions } = await import(
  path.join(process.cwd(), "lib/importer/shopify/characterPagesSync.server.js")
);
const { classificarAcoesAutorizadas } = await import(path.join(process.cwd(), "lib/importer/catalog/characterCycleAllowlist.js"));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const P = "gid://shopify/Product/16143595929930";
const GID_YODA = "gid://shopify/Metaobject/yoda";
const GID_GROGU = "gid://shopify/Metaobject/grogu";
const existing = new Map([
  ["yoda", { id: GID_YODA, status: "ACTIVE" }],
  ["grogu", { id: GID_GROGU, status: "ACTIVE" }],
]);
const actionsTrocaYodaGrogu = [
  { handle: "grogu", action: "update", targetStatus: "ACTIVE" },
  { handle: "yoda", action: "set-draft", targetStatus: "DRAFT" },
];
const liveCountsTroca = new Map([
  ["grogu", { productIds: [P] }],
  ["yoda", { productIds: [] }],
]);

function clienteFalso() {
  const escritas = [];
  return {
    escritas,
    async graphql(query, vars) {
      if (query.includes("metafieldsSet")) {
        escritas.push(vars.metafields[0]);
        return { metafieldsSet: { userErrors: [] } };
      }
      throw new Error("consulta inesperada no teste");
    },
  };
}

await check("troca yoda -> grogu gera um product-update com grogu", async () => {
  const ups = planProductCharacterUpdates(actionsTrocaYodaGrogu, liveCountsTroca, [{ id: P, sku: "SKU-1", currentCharacterGids: [GID_YODA] }], existing);
  assert.equal(ups.length, 1);
  assert.equal(ups[0].action, "product-update");
  assert.deepEqual(ups[0].handles, ["grogu"]);
});

await check("produto já correto não gera product-update", async () => {
  const ups = planProductCharacterUpdates(actionsTrocaYodaGrogu, liveCountsTroca, [{ id: P, sku: "SKU-1", currentCharacterGids: [GID_GROGU] }], existing);
  assert.deepEqual(ups, []);
});

await check("produto com etiqueta de personagem sem ligação gera product-update vazio", async () => {
  const ups = planProductCharacterUpdates(actionsTrocaYodaGrogu, new Map([["grogu", { productIds: [] }]]), [{ id: P, sku: "SKU-1", currentCharacterGids: [GID_YODA] }], existing);
  assert.equal(ups.length, 1);
  assert.deepEqual(ups[0].handles, []);
});

await check("gid sem metaobject conhecido conta como divergência", async () => {
  const ups = planProductCharacterUpdates(actionsTrocaYodaGrogu, liveCountsTroca, [{ id: P, sku: "SKU-1", currentCharacterGids: [GID_GROGU, "gid://shopify/Metaobject/apagado"] }], existing);
  assert.equal(ups.length, 1);
});

await check("apply escreve grogu no produto e não yoda", async () => {
  const [up] = planProductCharacterUpdates(actionsTrocaYodaGrogu, liveCountsTroca, [{ id: P, sku: "SKU-1", currentCharacterGids: [GID_YODA] }], existing);
  const cliente = clienteFalso();
  const r = await applyCharacterActions(cliente, { actionsToApply: [up], liveCounts: liveCountsTroca, existing });
  assert.equal(r.productWrites, 1);
  assert.equal(cliente.escritas.length, 1);
  assert.equal(cliente.escritas[0].ownerId, P);
  assert.equal(cliente.escritas[0].key, "character");
  assert.deepEqual(JSON.parse(cliente.escritas[0].value), [GID_GROGU]);
});

await check("personagem sem gid conhecido não entra no metafield", async () => {
  const up = { action: "product-update", productId: P, sku: "SKU-1", handles: ["darth-maul"], targetStatus: undefined };
  const cliente = clienteFalso();
  await applyCharacterActions(cliente, { actionsToApply: [up], liveCounts: new Map(), existing: new Map() });
  assert.deepEqual(JSON.parse(cliente.escritas[0].value), []);
});

await check("allowlist aceita product-update e ignora noop", () => {
  const { permitidas, fora } = classificarAcoesAutorizadas([
    { handle: "x", action: "product-update" },
    { handle: "y", action: "noop" },
  ]);
  assert.deepEqual(permitidas.map((a) => a.action), ["product-update"]);
  assert.deepEqual(fora, []);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nok: character-product-update");
