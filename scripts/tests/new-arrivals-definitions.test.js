#!/usr/bin/env node
/**
 * P4 (briefing 27/09) — precondição de criação de alterpop.is_new_arrival.
 * Uma definição usada numa regra de smart collection fica fechada a updates (caso real
 * alterpop.franchise, 27/09). Estes testes provam que:
 *   - o create path de ensureMetafieldDefinition envia access E capabilities
 *     (faltava capabilities — mesma classe do `pin` perdido da ADENDA 2);
 *   - a regra da new-arrivals só avança com a definição já na forma final.
 * Uso: node scripts/tests/new-arrivals-definitions.test.js
 */
import assert from "node:assert/strict";
import { ensureMetafieldDefinition } from "../../lib/importer/shopify/metafieldSetup.js";
import {
  ALTERPOP_IS_NEW_ARRIVAL_DEFINITION,
  ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION,
  checkDefinitionReadyForCollectionRule,
} from "../../lib/importer/shopify/newArrivalsDefinitions.js";

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

/** Cliente falso: a query de existência não encontra nada, o create devolve a definição. */
function fakeCreateClient() {
  const calls = [];
  return {
    calls,
    async graphql(query, variables) {
      calls.push({ query, variables });
      if (/metafieldDefinitionCreate/.test(query)) {
        return {
          metafieldDefinitionCreate: {
            createdDefinition: { id: "gid://shopify/MetafieldDefinition/9", ...variables.definition, type: { name: variables.definition.type } },
            userErrors: [],
          },
        };
      }
      return { metafieldDefinitions: { nodes: [] } };
    },
  };
}

const createInput = (client) => client.calls.find((c) => /metafieldDefinitionCreate/.test(c.query))?.variables.definition;

await check("create — is_new_arrival nasce com access.storefront PUBLIC_READ", async () => {
  const client = fakeCreateClient();
  await ensureMetafieldDefinition(client, ALTERPOP_IS_NEW_ARRIVAL_DEFINITION);
  assert.equal(createInput(client)?.access?.storefront, "PUBLIC_READ");
});

await check("create — is_new_arrival nasce com smartCollectionCondition ligado (capabilities chega à mutação)", async () => {
  const client = fakeCreateClient();
  await ensureMetafieldDefinition(client, ALTERPOP_IS_NEW_ARRIVAL_DEFINITION);
  assert.equal(createInput(client)?.capabilities?.smartCollectionCondition?.enabled, true);
});

await check("create — nunca declara access.admin (namespace merchant-owned)", async () => {
  const client = fakeCreateClient();
  await ensureMetafieldDefinition(client, ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION);
  assert.equal("admin" in (createInput(client)?.access || {}), false);
});

await check("shapes — is_new_arrival boolean; first_published_at date_time; ambos PUBLIC_READ", () => {
  assert.equal(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION.type, "boolean");
  assert.equal(ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION.type, "date_time");
  assert.equal(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION.access.storefront, "PUBLIC_READ");
  assert.equal(ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION.access.storefront, "PUBLIC_READ");
});

const ready = {
  id: "gid://shopify/MetafieldDefinition/9",
  type: { name: "boolean" },
  access: { admin: "PUBLIC_READ_WRITE", storefront: "PUBLIC_READ" },
  capabilities: { smartCollectionCondition: { enabled: true } },
};

await check("guarda — ok com a definição na forma final", () => {
  assert.deepEqual(checkDefinitionReadyForCollectionRule(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, ready), { ok: true, reasons: [] });
});

await check("guarda — recusa storefront NONE (ficava fechado assim para sempre, caso franchise)", () => {
  const r = checkDefinitionReadyForCollectionRule(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, { ...ready, access: { storefront: "NONE" } });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /storefront NONE ≠ PUBLIC_READ/);
});

await check("guarda — recusa smartCollectionCondition desligado", () => {
  const r = checkDefinitionReadyForCollectionRule(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, {
    ...ready,
    capabilities: { smartCollectionCondition: { enabled: false } },
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /smartCollectionCondition desligado/);
});

await check("guarda — recusa definição inexistente e tipo errado", () => {
  assert.equal(checkDefinitionReadyForCollectionRule(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, null).ok, false);
  const r = checkDefinitionReadyForCollectionRule(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, { ...ready, type: { name: "single_line_text_field" } });
  assert.match(r.reasons.join(), /tipo/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nnew-arrivals-definitions: todos os casos passaram");
