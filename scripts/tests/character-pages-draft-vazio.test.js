#!/usr/bin/env node
/* eslint-env node */
/**
 * applyCharacterActions: um Character com 0 produtos passa a DRAFT sem erro (passo D, 27/10/2026).
 * `products` é opcional na definição do metaobject `character` desde essa data, por isso a
 * recusa "não pode estar em branco" já não existe e não há caminho à parte para ela.
 * Cliente Shopify falso, sem rede. Uso: node scripts/tests/character-pages-draft-vazio.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "draft-vazio-unused.sqlite")}`;
const { applyCharacterActions, planProductCharacterUpdates } = await import(path.join(process.cwd(), "lib/importer/shopify/characterPagesSync.server.js"));

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

/** Cliente falso: regista os upserts (com as fields enviadas) e os metafieldsSet. */
function fakeClient({ upsertErrorHandles = {} } = {}) {
  const calls = [];
  const upserts = [];
  return {
    calls,
    upserts,
    async graphql(query, vars) {
      if (/collectionByHandle/.test(query)) return { collectionByHandle: { id: "gid://shopify/Collection/1" } };
      if (/metaobjectUpsert/.test(query)) {
        const handle = vars.handle.handle;
        upserts.push({ handle, metaobject: vars.metaobject });
        calls.push(`upsert:${handle}`);
        const msg = upsertErrorHandles[handle];
        if (msg) return { metaobjectUpsert: { userErrors: [{ field: ["fields"], message: msg, code: "X" }] } };
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

// A remoção da referência no produto vem do product-update (29/10/2026), não do set-draft.
const draftVazio = (extra = {}) => {
  const setDraft = { handle: "luffy", action: "set-draft", targetStatus: "DRAFT", universo: "One Piece", count: 0 };
  const existing = new Map([["luffy", { id: "gid://shopify/Metaobject/luffy", status: "ACTIVE" }]]);
  const activeProducts = [{ id: "gid://shopify/Product/9", sku: "SKU-9", currentCharacterGids: ["gid://shopify/Metaobject/luffy"] }];
  const liveCounts = new Map();
  return {
    actionsToApply: [setDraft, ...planProductCharacterUpdates([setDraft], liveCounts, activeProducts, existing)],
    liveCounts,
    existing,
    ...extra,
  };
};

await check("0 produtos -> set-draft sem erro, sem enviar products, referência tirada do produto", async () => {
  const client = fakeClient();
  const r = await applyCharacterActions(client, draftVazio());
  assert.deepEqual(r.applied.map((a) => a.handle), ["luffy"]);
  assert.equal(client.upserts.length, 1);
  assert.deepEqual(client.upserts[0].metaobject, { capabilities: { publishable: { status: "DRAFT" } } });
  assert.ok(client.calls.includes("set:gid://shopify/Product/9:character"));
});

await check("o resultado já não tem campo undraftable", async () => {
  const r = await applyCharacterActions(fakeClient(), draftVazio());
  assert.equal("undraftable" in r, false);
});

await check("qualquer erro no set-draft aborta, incluindo o de campo em branco", async () => {
  const client = fakeClient({ upsertErrorHandles: { luffy: "Produtos não pode estar em branco" } });
  await assert.rejects(() => applyCharacterActions(client, draftVazio()), /metaobjectUpsert\(luffy\): Produtos não pode estar em branco/);
  assert.ok(!client.calls.some((c) => c.startsWith("set:")));
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ncharacter-pages-draft-vazio: todos os casos passaram");
process.exit(0);
