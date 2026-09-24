#!/usr/bin/env node
/**
 * B14 (briefing backend, 24/09/2026), secção 6 — collectionPublication.server.js.
 * Uso: node scripts/tests/collection-publication.test.js
 */
import assert from "node:assert/strict";
import {
  validateAccessScopes,
  validatePublicationId,
  checkCyclePreconditions,
  resolveOwningUniverseStatus,
  publishCollectionOnCreation,
  classifyReconciliationAction,
  planReconciliation,
  ONLINE_STORE_PUBLICATION_ID,
  MAX_AUTO_PUBLISH,
} from "../../lib/importer/shopify/collectionPublication.server.js";
import { UNIVERSE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseUniverses.js";
import { LINE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseLines.js";

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
const ALL_SCOPES = ["read_products", "write_products", "read_publications", "write_publications"];

/** Client falso: responde às duas queries de precondição e ao publishablePublish. */
function makeFakeClient({ grantedScopes = ALL_SCOPES, availablePublicationIds = [VALID_PUB_ID], publishUserErrors = [] } = {}) {
  const publishCalls = [];
  return {
    publishCalls,
    async graphql(query, variables) {
      if (query.includes("CollPubAccessScopes")) {
        return { currentAppInstallation: { accessScopes: grantedScopes.map((handle) => ({ handle })) } };
      }
      if (query.includes("CollPubPublications")) {
        return { publications: { nodes: availablePublicationIds.map((id) => ({ id, name: "Online Store" })) } };
      }
      if (query.includes("CollPubPublish")) {
        publishCalls.push(variables);
        return { publishablePublish: { userErrors: publishUserErrors } };
      }
      throw new Error(`query inesperada no fake client: ${query.slice(0, 60)}`);
    },
  };
}

// ── write_publications em falta ──

check("validateAccessScopes — falha com write_publications em falta", () => {
  const result = validateAccessScopes(["read_products", "read_publications"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["write_publications"]);
});

check("validateAccessScopes — ok com os dois scopes de publicação", () => {
  assert.equal(validateAccessScopes(ALL_SCOPES).ok, true);
});

await checkAsync("checkCyclePreconditions — salta a publicação (ok:false) com write_publications em falta", async () => {
  const client = makeFakeClient({ grantedScopes: ["read_products", "read_publications"] });
  const result = await checkCyclePreconditions(client, VALID_PUB_ID);
  assert.equal(result.ok, false);
  assert.match(result.reason, /write_publications/);
});

// ── publicationId inválido ──

check("validatePublicationId — falha se o id não está em publications(first: 50)", () => {
  const result = validatePublicationId(["gid://shopify/Publication/9"], VALID_PUB_ID);
  assert.equal(result.ok, false);
  assert.match(result.reason, /não encontrado/);
});

check("validatePublicationId — ok se o id existe na loja", () => {
  assert.equal(validatePublicationId([VALID_PUB_ID], VALID_PUB_ID).ok, true);
});

await checkAsync("checkCyclePreconditions — salta a publicação (ok:false) com publicationId inválido", async () => {
  const client = makeFakeClient({ availablePublicationIds: ["gid://shopify/Publication/999"] });
  const result = await checkCyclePreconditions(client, VALID_PUB_ID);
  assert.equal(result.ok, false);
  assert.match(result.reason, /publicationId/);
});

await checkAsync("checkCyclePreconditions — ok quando scopes e publicationId batem", async () => {
  const client = makeFakeClient();
  const result = await checkCyclePreconditions(client, VALID_PUB_ID);
  assert.equal(result.ok, true);
});

// ── universo closed ──

check('resolveOwningUniverseStatus — "The Legend of Zelda" (closed) devolve "closed"', () => {
  const status = resolveOwningUniverseStatus({ templateSuffix: UNIVERSE_TEMPLATE_SUFFIX, title: "The Legend of Zelda" });
  assert.equal(status, "closed");
});

check('resolveOwningUniverseStatus — "Batman" (open) devolve "open"', () => {
  const status = resolveOwningUniverseStatus({ templateSuffix: UNIVERSE_TEMPLATE_SUFFIX, title: "Batman" });
  assert.equal(status, "open");
});

check("resolveOwningUniverseStatus — uma Line herda o status do universo parent (The Mandalorian -> Star Wars, open)", () => {
  const status = resolveOwningUniverseStatus({ templateSuffix: LINE_TEMPLATE_SUFFIX, title: "The Mandalorian" });
  assert.equal(status, "open");
});

check("resolveOwningUniverseStatus — universo/line desconhecido devolve null, nunca 'open' por omissão", () => {
  assert.equal(resolveOwningUniverseStatus({ templateSuffix: UNIVERSE_TEMPLATE_SUFFIX, title: "Universo Inexistente" }), null);
  assert.equal(resolveOwningUniverseStatus({ templateSuffix: null, title: "Batman" }), null);
});

await checkAsync("publishCollectionOnCreation — universo closed: salta, nunca chama publishablePublish", async () => {
  const client = makeFakeClient();
  const result = await publishCollectionOnCreation(client, {
    collection: { id: "gid://shopify/Collection/1", handle: "zelda", title: "The Legend of Zelda", templateSuffix: UNIVERSE_TEMPLATE_SUFFIX },
    publicationId: VALID_PUB_ID,
  });
  assert.equal(result.published, false);
  assert.equal(result.skipped, true);
  assert.equal(client.publishCalls.length, 0);
});

// ── userErrors simulado ──

await checkAsync("publishCollectionOnCreation — userErrors: devolve failed, nunca finge sucesso", async () => {
  const client = makeFakeClient({
    publishUserErrors: [{ field: ["publicationId"], message: "Publication is not valid for this shop" }],
  });
  const result = await publishCollectionOnCreation(client, {
    collection: { id: "gid://shopify/Collection/1", handle: "batman", title: "Batman", templateSuffix: UNIVERSE_TEMPLATE_SUFFIX },
    publicationId: VALID_PUB_ID,
  });
  assert.equal(result.published, false);
  assert.equal(result.failed, true);
  assert.equal(result.errors.length, 1);
});

await checkAsync("publishCollectionOnCreation — universo open, sem userErrors: publica de facto", async () => {
  const client = makeFakeClient();
  const result = await publishCollectionOnCreation(client, {
    collection: { id: "gid://shopify/Collection/1", handle: "batman", title: "Batman", templateSuffix: UNIVERSE_TEMPLATE_SUFFIX },
    publicationId: VALID_PUB_ID,
  });
  assert.equal(result.published, true);
  assert.equal(client.publishCalls.length, 1);
  assert.deepEqual(client.publishCalls[0], { id: "gid://shopify/Collection/1", pub: VALID_PUB_ID });
});

// ── SUPPLIER_TOKENS avisa mas publica na mesma ──

await checkAsync("publishCollectionOnCreation — descrição com placeholder interno: avisa mas publica na mesma", async () => {
  const client = makeFakeClient();
  const result = await publishCollectionOnCreation(client, {
    collection: {
      id: "gid://shopify/Collection/1",
      handle: "batman",
      title: "Batman",
      templateSuffix: UNIVERSE_TEMPLATE_SUFFIX,
      descriptionHtml: "<p>Coleção Universe — produtos com alterpop.franchise = Batman.</p>",
    },
    publicationId: VALID_PUB_ID,
  });
  assert.equal(result.published, true);
  assert.equal(result.warning?.code, "SUPPLIER_TOKENS");
  assert.equal(client.publishCalls.length, 1);
});

// ── reconciliação (secção 7) ──

check('classifyReconciliationAction — open e não publicada -> "publish"', () => {
  const result = classifyReconciliationAction({ templateSuffix: UNIVERSE_TEMPLATE_SUFFIX, title: "Batman", publishedOnPublication: false });
  assert.equal(result.action, "publish");
});

check('classifyReconciliationAction — closed e publicada -> "register-only" (nunca despublica)', () => {
  const result = classifyReconciliationAction({ templateSuffix: UNIVERSE_TEMPLATE_SUFFIX, title: "The Legend of Zelda", publishedOnPublication: true });
  assert.equal(result.action, "register-only");
});

check('classifyReconciliationAction — closed e não publicada -> "noop"', () => {
  const result = classifyReconciliationAction({ templateSuffix: UNIVERSE_TEMPLATE_SUFFIX, title: "The Legend of Zelda", publishedOnPublication: false });
  assert.equal(result.action, "noop");
});

check('classifyReconciliationAction — open e já publicada -> "noop" (inclui 0 produtos: nada a fazer)', () => {
  const result = classifyReconciliationAction({ templateSuffix: UNIVERSE_TEMPLATE_SUFFIX, title: "Batman", publishedOnPublication: true, productsCount: 0 });
  assert.equal(result.action, "noop");
});

check("planReconciliation — até MAX_AUTO_PUBLISH por publicar: publica todas", () => {
  const collections = Array.from({ length: MAX_AUTO_PUBLISH }, (_, i) => ({
    handle: `h${i}`,
    title: "Batman",
    templateSuffix: UNIVERSE_TEMPLATE_SUFFIX,
    publishedOnPublication: false,
  }));
  const plan = planReconciliation(collections);
  assert.equal(plan.brakeTriggered, false);
  assert.equal(plan.toPublish.length, MAX_AUTO_PUBLISH);
});

check("planReconciliation — trava: mais de MAX_AUTO_PUBLISH por publicar não publica NENHUMA", () => {
  const collections = Array.from({ length: MAX_AUTO_PUBLISH + 1 }, (_, i) => ({
    handle: `h${i}`,
    title: "Batman",
    templateSuffix: UNIVERSE_TEMPLATE_SUFFIX,
    publishedOnPublication: false,
  }));
  const plan = planReconciliation(collections);
  assert.equal(plan.brakeTriggered, true);
  assert.deepEqual(plan.toPublish, []);
});

check("ONLINE_STORE_PUBLICATION_ID — vem de config, nunca hardcoded na mutation", () => {
  assert.ok(ONLINE_STORE_PUBLICATION_ID.startsWith("gid://shopify/Publication/"));
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ncollection-publication: todos os casos passaram");
