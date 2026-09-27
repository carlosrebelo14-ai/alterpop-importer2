#!/usr/bin/env node
/**
 * Briefing 27/09 — alinhar definições alterpop.* com a forma declarada
 * (access.storefront + capabilities.smartCollectionCondition).
 *
 * Dois defeitos reais que este teste apanha:
 *   - ADENDA 2 (18/09): o `pin` perdia-se em silêncio no caminho de escrita.
 *   - 27/09: um update só com `access` desligou o smartCollectionCondition de
 *     alterpop.format (a Shopify repõe capabilities omitidas no input).
 * Falha se `access` ou `capabilities` deixarem de chegar à mutação.
 * Uso: node scripts/tests/metafield-definition-access.test.js
 */
import assert from "node:assert/strict";
import {
  buildDefinitionShapeUpdateInput,
  planDefinitionShapeUpdates,
  readSmartCollectionDefinitionUsage,
  updateMetafieldDefinitionShape,
} from "../../lib/importer/shopify/metafieldSetup.js";
import {
  ALTERPOP_FRANCHISE_DEFINITION,
  ALTERPOP_FORMAT_DEFINITION,
  ALTERPOP_LINE_DEFINITION,
  ALTERPOP_MANUFACTURER_LINE_DEFINITION,
} from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";

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

/** Cliente falso que guarda as variáveis enviadas e responde como a Shopify —
 *  incluindo o comportamento real de 27/09: capability omitida volta a false. */
function fakeShopify() {
  const calls = [];
  return {
    calls,
    async graphql(query, variables) {
      calls.push({ query, variables });
      const d = variables.definition;
      return {
        metafieldDefinitionUpdate: {
          updatedDefinition: {
            id: "gid://shopify/MetafieldDefinition/1",
            namespace: d.namespace,
            key: d.key,
            access: { admin: "PUBLIC_READ_WRITE", storefront: d.access?.storefront ?? "NONE" },
            capabilities: { smartCollectionCondition: { enabled: d.capabilities?.smartCollectionCondition?.enabled === true } },
          },
          userErrors: [],
        },
      };
    },
  };
}

const live = (storefront, scc) => ({
  access: { admin: "PUBLIC_READ_WRITE", storefront },
  capabilities: { smartCollectionCondition: { enabled: scc } },
});

await check("build — caso real 27/09: format PUBLIC_READ mas scc=false → repõe scc=true", () => {
  const input = buildDefinitionShapeUpdateInput(ALTERPOP_FORMAT_DEFINITION, live("PUBLIC_READ", false));
  assert.deepEqual(input, {
    namespace: "alterpop",
    key: "format",
    ownerType: "PRODUCT",
    access: { storefront: "PUBLIC_READ" },
    capabilities: { smartCollectionCondition: { enabled: true } },
  });
});

await check("build — muda só o acesso mas leva SEMPRE a capability declarada", () => {
  const input = buildDefinitionShapeUpdateInput(ALTERPOP_FORMAT_DEFINITION, live("NONE", true));
  assert.equal(input.access.storefront, "PUBLIC_READ");
  assert.equal(input.capabilities?.smartCollectionCondition?.enabled, true);
});

await check("build — nunca declara access.admin (namespace merchant-owned)", () => {
  const input = buildDefinitionShapeUpdateInput(ALTERPOP_FORMAT_DEFINITION, live("NONE", false));
  assert.equal("admin" in input.access, false);
});

await check("build — idempotente: null quando a loja bate com a forma", () => {
  assert.equal(buildDefinitionShapeUpdateInput(ALTERPOP_FORMAT_DEFINITION, live("PUBLIC_READ", true)), null);
  assert.equal(buildDefinitionShapeUpdateInput(ALTERPOP_FRANCHISE_DEFINITION, live("NONE", true)), null);
});

await check("update — access e capabilities chegam à mutação; a resposta mantém scc=true", async () => {
  const client = fakeShopify();
  const input = buildDefinitionShapeUpdateInput(ALTERPOP_FORMAT_DEFINITION, live("NONE", true));
  const updated = await updateMetafieldDefinitionShape(client, input);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].query, /metafieldDefinitionUpdate/);
  assert.equal(client.calls[0].variables.definition.access?.storefront, "PUBLIC_READ");
  assert.equal(client.calls[0].variables.definition.capabilities?.smartCollectionCondition?.enabled, true);
  assert.equal(updated.capabilities.smartCollectionCondition.enabled, true);
});

await check("update — lança se a resposta perder a capability (nada em silêncio)", async () => {
  const client = {
    async graphql() {
      return {
        metafieldDefinitionUpdate: {
          updatedDefinition: { access: { storefront: "PUBLIC_READ" }, capabilities: { smartCollectionCondition: { enabled: false } } },
          userErrors: [],
        },
      };
    },
  };
  await assert.rejects(
    updateMetafieldDefinitionShape(client, {
      namespace: "alterpop", key: "format", ownerType: "PRODUCT",
      access: { storefront: "PUBLIC_READ" },
      capabilities: { smartCollectionCondition: { enabled: true } },
    }),
    /smartCollectionCondition=false, esperado true/,
  );
});

await check("update — lança em userErrors (caso real: definição usada em smart collection)", async () => {
  const client = {
    async graphql() {
      return {
        metafieldDefinitionUpdate: {
          updatedDefinition: null,
          userErrors: [{ field: ["definition"], message: "This metafield definition is being used in a smart collection." }],
        },
      };
    },
  };
  await assert.rejects(
    updateMetafieldDefinitionShape(client, {
      namespace: "alterpop", key: "franchise", ownerType: "PRODUCT",
      access: { storefront: "PUBLIC_READ" },
      capabilities: { smartCollectionCondition: { enabled: true } },
    }),
    /being used in a smart collection/,
  );
});

// ── P1 (BLOQUEADA_POR_COLECAO) e P2 (plano calculado a partir da loja) ──

const FRANCHISE_ID = "gid://shopify/MetafieldDefinition/1520603857226";
const FORMAT_ID = "gid://shopify/MetafieldDefinition/1525101363530";
const withId = (id, cur) => ({ id, ...cur });

await check("plan — caso real 27/09: definição em uso numa smart collection sai do plano como bloqueada", () => {
  const shape = { ...ALTERPOP_FRANCHISE_DEFINITION, access: { storefront: "PUBLIC_READ" } };
  const usage = new Map([[FRANCHISE_ID, ["one-piece", "star-wars"]]]);
  const { plan, blocked } = planDefinitionShapeUpdates(
    [{ def: shape, current: withId(FRANCHISE_ID, live("NONE", true)) }],
    usage,
  );
  assert.equal(plan.length, 0);
  assert.equal(blocked.length, 1);
  assert.deepEqual(blocked[0].collections, ["one-piece", "star-wars"]);
});

await check("plan — divergente e sem coleção entra no plano; alinhada salta", () => {
  const usage = new Map([[FRANCHISE_ID, ["one-piece"]]]);
  const { plan, blocked, aligned } = planDefinitionShapeUpdates(
    [
      { def: ALTERPOP_FRANCHISE_DEFINITION, current: withId(FRANCHISE_ID, live("NONE", true)) },
      { def: ALTERPOP_FORMAT_DEFINITION, current: withId(FORMAT_ID, live("PUBLIC_READ", false)) },
    ],
    usage,
  );
  assert.deepEqual(plan.map((p) => p.def.key), ["format"]);
  assert.equal(blocked.length, 0);
  assert.deepEqual(aligned.map((a) => a.def.key), ["franchise"]);
});

await check("plan — sem máximo estático: N divergentes livres dão N no plano", () => {
  const { plan } = planDefinitionShapeUpdates(
    [
      { def: ALTERPOP_FORMAT_DEFINITION, current: withId(FORMAT_ID, live("NONE", false)) },
      { def: { ...ALTERPOP_LINE_DEFINITION, access: { storefront: "PUBLIC_READ" } }, current: withId("gid://x/2", live("NONE", true)) },
      { def: { ...ALTERPOP_MANUFACTURER_LINE_DEFINITION, access: { storefront: "PUBLIC_READ" } }, current: withId("gid://x/3", live("NONE", true)) },
    ],
    new Map(),
  );
  assert.equal(plan.length, 3);
});

await check("usage — lê as regras de todas as páginas e mapeia definição → handles", async () => {
  const pages = [
    { collections: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [
      { handle: "one-piece", ruleSet: { rules: [{ column: "PRODUCT_METAFIELD_DEFINITION", conditionObject: { metafieldDefinition: { id: FRANCHISE_ID } } }] } },
      { handle: "new-arrivals", ruleSet: { rules: [{ column: "TAG", conditionObject: {} }] } },
    ] } },
    { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { handle: "star-wars", ruleSet: { rules: [{ column: "PRODUCT_METAFIELD_DEFINITION", conditionObject: { metafieldDefinition: { id: FRANCHISE_ID } } }] } },
    ] } },
  ];
  let i = 0;
  const usage = await readSmartCollectionDefinitionUsage({ async graphql() { return pages[i++]; } });
  assert.equal(i, 2);
  assert.deepEqual(usage.get(FRANCHISE_ID), ["one-piece", "star-wars"]);
  assert.equal(usage.size, 1);
});

await check("shapes — só format declara PUBLIC_READ; franchise, line e manufacturer_line ficam NONE", () => {
  assert.equal(ALTERPOP_FORMAT_DEFINITION.access?.storefront, "PUBLIC_READ");
  assert.equal(ALTERPOP_FRANCHISE_DEFINITION.access, undefined);
  assert.equal(ALTERPOP_LINE_DEFINITION.access, undefined);
  assert.equal(ALTERPOP_MANUFACTURER_LINE_DEFINITION.access, undefined);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nmetafield-definition-access: todos os casos passaram");
