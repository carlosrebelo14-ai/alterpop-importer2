#!/usr/bin/env node
/**
 * Só leitura — briefing 27/09, passo 2 (antes de N1/N2).
 *   1. Condição de metafield booleano disponível nas smart collections da loja?
 *      (collectionRulesConditions + capability smartCollectionCondition de qualquer
 *      definição boolean de PRODUCT que já exista)
 *   2. Tipo, acesso storefront e capabilities de alterpop.franchise.
 *   3. Estado atual da coleção new-arrivals (regras, ordenação, contagem).
 *   4. Se alterpop.is_new_arrival / alterpop.first_published_at já existem.
 *
 * Não escreve nada.
 *
 *   flyctl ssh console -a alterpop-importer-app \
 *     -C "node scripts/catalog/audit-2709-preconditions.js"
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

const QUERY = `
  query Probe($after: String) {
    collectionRulesConditions {
      ruleType
      allowedRelations
      defaultRelation
      ruleObject {
        __typename
        ... on CollectionRuleMetafieldCondition { metafieldDefinition { namespace key type { name } } }
      }
    }
    metafieldDefinitions(first: 100, ownerType: PRODUCT, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id namespace key name
        type { name }
        access { admin storefront }
        pinnedPosition
        capabilities {
          smartCollectionCondition { eligible enabled }
          adminFilterable { eligible enabled status }
        }
      }
    }
    collectionByIdentifier(identifier: { handle: "new-arrivals" }) {
      id title handle sortOrder updatedAt
      productsCount { count }
      ruleSet { appliedDisjunctively rules { column relation condition conditionObject { __typename } } }
    }
  }
`;

async function main() {
  console.log(`=== audit-2709-preconditions (${SHOP}) · só leitura ===`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const defs = [];
  let first = null;
  let after = null;
  do {
    const data = await client.graphql(QUERY, { after });
    if (!first) first = data;
    defs.push(...data.metafieldDefinitions.nodes);
    after = data.metafieldDefinitions.pageInfo.hasNextPage
      ? data.metafieldDefinitions.pageInfo.endCursor
      : null;
  } while (after);

  console.log(`\n--- 1. collectionRulesConditions (metafield) ---`);
  for (const c of first.collectionRulesConditions) {
    if (!/METAFIELD/.test(c.ruleType)) continue;
    const d = c.ruleObject?.metafieldDefinition;
    console.log(
      `  ${c.ruleType} relations=${c.allowedRelations.join("|")}` +
        (d ? ` def=${d.namespace}.${d.key} (${d.type.name})` : ""),
    );
  }

  const booleans = defs.filter((d) => d.type.name === "boolean");
  console.log(`\n--- 1b. definições boolean de PRODUCT: ${booleans.length} ---`);
  for (const d of booleans) {
    console.log(`  ${d.namespace}.${d.key} smartCollectionCondition=${JSON.stringify(d.capabilities.smartCollectionCondition)}`);
  }

  console.log(`\n--- 2. definições alterpop.* (${defs.length} definições PRODUCT no total) ---`);
  for (const d of defs.filter((x) => x.namespace === "alterpop")) {
    console.log(
      `  ${d.namespace}.${d.key} type=${d.type.name} storefront=${d.access.storefront} admin=${d.access.admin}` +
        ` pin=${d.pinnedPosition ?? "-"} scc=${JSON.stringify(d.capabilities.smartCollectionCondition)}` +
        ` adminFilterable=${JSON.stringify(d.capabilities.adminFilterable)} id=${d.id}`,
    );
  }

  console.log(`\n--- 3. coleção new-arrivals ---`);
  console.log(JSON.stringify(first.collectionByIdentifier, null, 2));

  const want = ["is_new_arrival", "first_published_at"];
  console.log(`\n--- 4. definições N1 já existentes ---`);
  for (const k of want) {
    const d = defs.find((x) => x.namespace === "alterpop" && x.key === k);
    console.log(`  alterpop.${k}: ${d ? `${d.type.name} ${d.id}` : "não existe"}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
