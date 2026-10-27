#!/usr/bin/env node
/**
 * PR 4, desvio 2 (27/10/2026) — metafields no productCreate e metaobjects antes da criação.
 * Uso: node scripts/tests/character-create.test.js
 */
import assert from "node:assert/strict";
import { buildCreateMetafields, ensureCharacterGids } from "../../lib/importer/shopify/characterCreate.server.js";

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

/** Cliente falso: collectionByHandle, metaobjectByHandle e metaobjectUpsert. */
function fakeClient({ existing = {}, upsertErrors = [] } = {}) {
  const upserts = [];
  return {
    upserts,
    async graphql(query, vars) {
      if (query.includes("collectionByHandle")) return { collectionByHandle: { id: "gid://shopify/Collection/1" } };
      if (query.includes("metaobjectByHandle")) {
        const h = vars.handle.handle;
        return { metaobjectByHandle: existing[h] ? { id: existing[h], handle: h } : null };
      }
      if (query.includes("metaobjectUpsert")) {
        upserts.push(vars);
        return { metaobjectUpsert: { metaobject: { id: `gid://shopify/Metaobject/new-${vars.handle.handle}` }, userErrors: upsertErrors } };
      }
      throw new Error(`query inesperada: ${query.slice(0, 40)}`);
    },
  };
}

await check("franquia e personagens entram como metafields do productCreate", () => {
  const m = buildCreateMetafields({ franchiseName: "Star Wars", characterGids: ["gid://shopify/Metaobject/1"] });
  assert.deepEqual(m, [
    { namespace: "alterpop", key: "franchise", type: "list.single_line_text_field", value: '["Star Wars"]' },
    { namespace: "alterpop", key: "character", type: "list.metaobject_reference", value: '["gid://shopify/Metaobject/1"]' },
  ]);
});

await check("sem personagens -> só franquia, sem alterpop.character vazio", () => {
  const m = buildCreateMetafields({ franchiseName: "Star Wars", characterGids: [] });
  assert.deepEqual(m.map((x) => x.key), ["franchise"]);
});

await check("universo dormente (Wonder Woman) -> sem franquia", () => {
  const m = buildCreateMetafields({ franchiseName: "Wonder Woman", characterGids: [] });
  assert.deepEqual(m, []);
});

await check("sem franquia nem personagens -> input intacto (lista vazia)", () => {
  assert.deepEqual(buildCreateMetafields({ franchiseName: null, characterGids: [] }), []);
});

await check("ensureCharacterGids reutiliza metaobject existente sem o alterar", async () => {
  const c = fakeClient({ existing: { "luke-skywalker": "gid://shopify/Metaobject/9" } });
  const gids = await ensureCharacterGids(c, ["luke-skywalker"], "Star Wars");
  assert.deepEqual(gids, ["gid://shopify/Metaobject/9"]);
  assert.equal(c.upserts.length, 0);
});

await check("ensureCharacterGids cria em DRAFT, sem products, quando não existe", async () => {
  const c = fakeClient();
  const gids = await ensureCharacterGids(c, ["luke-skywalker"], "Star Wars");
  assert.deepEqual(gids, ["gid://shopify/Metaobject/new-luke-skywalker"]);
  const up = c.upserts[0];
  assert.deepEqual(up.metaobject.capabilities, { publishable: { status: "DRAFT" } });
  assert.deepEqual(up.metaobject.fields.map((f) => f.key), ["title", "universe"]);
});

await check("erro de userErrors na criação lança erro visível (não cria produto em silêncio)", async () => {
  const c = fakeClient({ upsertErrors: [{ field: ["products"], message: "Products can't be blank" }] });
  await assert.rejects(() => ensureCharacterGids(c, ["luke-skywalker"], "Star Wars"), /metaobjectUpsert\(luke-skywalker\)/);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
