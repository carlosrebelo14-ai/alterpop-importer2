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

const VALID_PUB_ID = "gid://shopify/Publication/1";

/** Client falso: sem coleções existentes (tudo cai em toCreate), collectionCreate
 *  devolve sucesso e regista o input recebido. Também responde às queries de
 *  checkCyclePreconditions e ao publishablePublish (collectionPublication.server.js),
 *  chamados por createUniverseCollections depois de cada criação. */
function makeFakeClient({ preconditionsOk = true } = {}) {
  const createCalls = [];
  const publishCalls = [];
  return {
    createCalls,
    publishCalls,
    async graphql(query, variables) {
      if (query.includes("UniverseCollExisting")) {
        return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
      }
      if (query.includes("UniverseCollCreate")) {
        createCalls.push(variables.input);
        return {
          collectionCreate: {
            collection: {
              id: `gid://shopify/Collection/${createCalls.length}`,
              handle: variables.input.handle,
              title: variables.input.title,
              templateSuffix: variables.input.templateSuffix,
            },
            userErrors: [],
          },
        };
      }
      if (query.includes("CollPubAccessScopes")) {
        return {
          currentAppInstallation: {
            accessScopes: preconditionsOk
              ? [{ handle: "read_publications" }, { handle: "write_publications" }]
              : [],
          },
        };
      }
      if (query.includes("CollPubPublications")) {
        return { publications: { nodes: preconditionsOk ? [{ id: VALID_PUB_ID, name: "Online Store" }] : [] } };
      }
      if (query.includes("CollPubPublish")) {
        publishCalls.push(variables);
        return { publishablePublish: { userErrors: [] } };
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

// ── publicação na criação (B14, 24/09/2026, secção 6) ──

await checkAsync(
  "createUniverseCollections — chama publishCollectionOnCreation depois de cada criação (regressão: falha se a chamada for removida)",
  async () => {
    const client = makeFakeClient();
    const { created } = await createUniverseCollections(client, { publicationId: VALID_PUB_ID });
    const openCreated = created.filter((c) => c.handle !== "zelda" && c.handle !== "studio-ghibli");

    assert.ok(
      client.publishCalls.length > 0,
      "publishablePublish nunca foi chamado — createUniverseCollections deixou de publicar na criação"
    );
    assert.equal(client.publishCalls.length, openCreated.length);
  }
);

await checkAsync("createUniverseCollections — universo closed (zelda, studio-ghibli): cria a coleção, nunca publica", async () => {
  const client = makeFakeClient();
  const { created } = await createUniverseCollections(client, { publicationId: VALID_PUB_ID });

  assert.ok(created.some((c) => c.handle === "zelda"));
  assert.ok(created.some((c) => c.handle === "studio-ghibli"));
  const publishedHandles = client.publishCalls.map((call) => {
    const created0 = created.find((c) => c.id === call.id);
    return created0?.handle;
  });
  assert.equal(publishedHandles.includes("zelda"), false);
  assert.equal(publishedHandles.includes("studio-ghibli"), false);
});

await checkAsync("createUniverseCollections — precondições falham (scopes/publicationId): cria na mesma, salta TODA a publicação", async () => {
  const client = makeFakeClient({ preconditionsOk: false });
  const { created } = await createUniverseCollections(client);

  assert.ok(created.length > 0, "precondições falhadas não podem impedir a criação");
  assert.equal(client.publishCalls.length, 0);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nuniverse-collections: todos os casos passaram");
