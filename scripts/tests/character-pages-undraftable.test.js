#!/usr/bin/env node
/* eslint-env node */
/**
 * applyCharacterActions: um set-draft recusado porque `products` está em branco não trava o resto.
 * Cliente Shopify falso, sem rede. Uso: node scripts/tests/character-pages-undraftable.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "undraftable-unused.sqlite")}`;
const { applyCharacterActions } = await import(path.join(process.cwd(), "lib/importer/shopify/characterPagesSync.server.js"));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ")}`);
  }
}

/** Cliente falso: regista as mutações; `blankHandles` recusam o upsert com a frase da Shopify. */
function fakeClient({ blankHandles = [], otherErrorHandles = [] } = {}) {
  const calls = [];
  return {
    calls,
    async graphql(query, vars) {
      if (/collectionByHandle/.test(query)) return { collectionByHandle: { id: "gid://shopify/Collection/1" } };
      if (/metaobjectUpsert/.test(query)) {
        const handle = vars.handle.handle;
        calls.push(`upsert:${handle}`);
        if (blankHandles.includes(handle)) return { metaobjectUpsert: { userErrors: [{ field: ["fields"], message: "Produtos can't be blank", code: "BLANK" }] } };
        if (otherErrorHandles.includes(handle)) return { metaobjectUpsert: { userErrors: [{ message: "Handle has already been taken" }] } };
        return { metaobjectUpsert: { metaobject: { id: `gid://shopify/Metaobject/${handle}` }, userErrors: [] } };
      }
      if (/metafieldsSet/.test(query)) {
        calls.push(`set:${vars.metafields[0].ownerId}:${vars.metafields[0].key}`);
        return { metafieldsSet: { userErrors: [] } };
      }
      throw new Error(`query inesperada: ${query.slice(0, 40)}`);
    },
  };
}
const args = (extra = {}) => ({
  actionsToApply: [
    { handle: "darth-vader", action: "update", targetStatus: "ACTIVE", universo: "Star Wars", nome: "Darth Vader", count: 1 },
    { handle: "frodo", action: "set-draft", targetStatus: "DRAFT", universo: "The Lord of the Rings", count: 0 },
    { handle: "gandalf", action: "update", targetStatus: "ACTIVE", universo: "The Lord of the Rings", nome: "Gandalf", count: 1 },
  ],
  liveCounts: new Map([
    ["darth-vader", { productIds: ["gid://shopify/Product/1"] }],
    ["gandalf", { productIds: ["gid://shopify/Product/2"] }],
  ]),
  existing: new Map([
    ["darth-vader", { id: "gid://shopify/Metaobject/darth-vader", status: "ACTIVE" }],
    ["frodo", { id: "gid://shopify/Metaobject/frodo", status: "ACTIVE" }],
    ["gandalf", { id: "gid://shopify/Metaobject/gandalf", status: "ACTIVE" }],
  ]),
  activeProducts: [
    { id: "gid://shopify/Product/1", currentCharacterGids: [] },
    { id: "gid://shopify/Product/2", currentCharacterGids: [] },
  ],
  ...extra,
});

await check("set-draft recusado por campo em branco: regista e segue; os outros Characters são escritos", async () => {
  const client = fakeClient({ blankHandles: ["frodo"] });
  const r = await applyCharacterActions(client, args());
  assert.deepEqual(r.undraftable.map((u) => u.handle), ["frodo"]);
  assert.deepEqual(r.applied.map((a) => a.handle), ["darth-vader", "gandalf"]);
  assert.equal(r.productWrites, 2);
  assert.ok(client.calls.includes("set:gid://shopify/Product/1:character"));
  assert.ok(client.calls.some((c) => c.endsWith(":characters")));
});
await check("outro erro no upsert continua a abortar (nada escrito depois)", async () => {
  const client = fakeClient({ otherErrorHandles: ["frodo"] });
  await assert.rejects(() => applyCharacterActions(client, args()), /metaobjectUpsert\(frodo\): Handle has already been taken/);
  assert.ok(!client.calls.some((c) => c.startsWith("set:")));
});
await check("sem recusas, undraftable vem vazio", async () => {
  const r = await applyCharacterActions(fakeClient(), args());
  assert.deepEqual(r.undraftable, []);
  assert.equal(r.applied.length, 3);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ncharacter-pages-undraftable: todos os casos passaram");
process.exit(0);
