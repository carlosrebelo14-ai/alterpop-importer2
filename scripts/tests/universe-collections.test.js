#!/usr/bin/env node
/**
 * B14 (briefing backend, 24/09/2026), secção 3 — universeCollections.server.js deixou
 * de escrever descriptionHtml no collectionCreate. Caso real: o placeholder interno
 * ("Coleção Universe — produtos com... Rascunho: confirmar e publicar no Admin.") que
 * ficou publicado em 21 coleções live — ver collectionDescriptionPlaceholder.js.
 * Uso: node scripts/tests/universe-collections.test.js
 */
import assert from "node:assert/strict";
import { createUniverseCollections } from "../../lib/importer/shopify/universeCollections.server.js";
import { matchPlaceholder } from "../../lib/importer/shopify/collectionDescriptionPlaceholder.js";

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

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

/** Client falso: sem coleções existentes (tudo cai em toCreate), collectionCreate
 *  devolve sucesso e regista o input recebido. */
function makeFakeClient() {
  const createCalls = [];
  return {
    createCalls,
    async graphql(query, variables) {
      if (query.includes("UniverseCollExisting")) {
        return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
      }
      if (query.includes("UniverseCollCreate")) {
        createCalls.push(variables.input);
        return {
          collectionCreate: {
            collection: { id: `gid://shopify/Collection/${createCalls.length}`, handle: variables.input.handle, title: variables.input.title },
            userErrors: [],
          },
        };
      }
      throw new Error(`query inesperada no fake client: ${query.slice(0, 60)}`);
    },
  };
}

await checkAsync("createUniverseCollections — nenhum collectionCreate leva descriptionHtml", async () => {
  const client = makeFakeClient();
  const { created } = await createUniverseCollections(client);

  assert.ok(created.length > 0, "esperava pelo menos uma coleção criada nos universos ativos");
  for (const input of client.createCalls) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(input, "descriptionHtml"),
      false,
      `collectionCreate para "${input.title}" não devia incluir descriptionHtml`
    );
  }
});

await checkAsync("createUniverseCollections — falha se a criação escrever qualquer um dos dois placeholders (regressão)", async () => {
  const client = makeFakeClient();
  await createUniverseCollections(client);

  for (const input of client.createCalls) {
    const html = input.descriptionHtml;
    assert.equal(
      matchPlaceholder(html),
      null,
      `collectionCreate para "${input.title}" escreveu um placeholder interno: "${html}"`
    );
  }
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nuniverse-collections: todos os casos passaram");
