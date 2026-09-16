#!/usr/bin/env node
/**
 * B6 (briefing backend, 16/09/2026) — cria a definição de metafield
 * `alterpop.manufacturer_line`.
 *
 * list.single_line_text_field, pinned, com capability smartCollectionCondition ligada.
 * Mesma forma que `alterpop.franchise`/`alterpop.line`/`alterpop.format` — ver
 * lib/importer/shopify/franchiseMetafieldDefinition.js. Key é `manufacturer_line`,
 * NUNCA `line` (já existe, é outra coisa — sub-divisão de universo, não de fabricante).
 *
 * Idempotente: se já existir, imprime o GID e não recria.
 *
 * Depois de correr, colar o GID devolvido em ALTERPOP_MANUFACTURER_LINE_DEFINITION_GID
 * (franchiseMetafieldDefinition.js).
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/manufacturer-line-metafield-definition.js
 *   node scripts/catalog/manufacturer-line-metafield-definition.js --dry-run
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { ALTERPOP_MANUFACTURER_LINE_DEFINITION } from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const FIND = `
  query ManufacturerLineDefFind {
    metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "alterpop", key: "manufacturer_line") {
      nodes { id name namespace key type { name } capabilities { smartCollectionCondition { enabled } } }
    }
  }
`;

const CREATE = `
  mutation ManufacturerLineDefCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id name namespace key type { name }
        capabilities { smartCollectionCondition { enabled } }
      }
      userErrors { field message code }
    }
  }
`;

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const found = (await client.graphql(FIND)).metafieldDefinitions?.nodes?.[0];
  if (found?.id) {
    console.log(`já existe: ${found.id}`);
    console.log(`  type: ${found.type?.name} · smartCollectionCondition.enabled: ${found.capabilities?.smartCollectionCondition?.enabled}`);
    console.log(`\n→ ALTERPOP_MANUFACTURER_LINE_DEFINITION_GID = "${found.id}"`);
    return;
  }

  const def = ALTERPOP_MANUFACTURER_LINE_DEFINITION;
  const definition = {
    namespace: def.namespace,
    key: def.key,
    name: def.name,
    description: def.description,
    ownerType: def.ownerType,
    type: def.type,
    pin: def.pin,
    capabilities: def.capabilities,
  };

  if (DRY) {
    console.log("DRY-RUN — criaria:");
    console.log(JSON.stringify(definition, null, 2));
    return;
  }

  const data = await client.graphql(CREATE, { definition });
  const errs = data.metafieldDefinitionCreate?.userErrors || [];
  if (errs.length) {
    console.error("userErrors:", JSON.stringify(errs, null, 2));
    process.exit(1);
  }
  const created = data.metafieldDefinitionCreate?.createdDefinition;
  console.log(`criada: ${created.id}`);
  console.log(`  type: ${created.type?.name} · smartCollectionCondition.enabled: ${created.capabilities?.smartCollectionCondition?.enabled}`);
  console.log(`\n→ ALTERPOP_MANUFACTURER_LINE_DEFINITION_GID = "${created.id}"`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
