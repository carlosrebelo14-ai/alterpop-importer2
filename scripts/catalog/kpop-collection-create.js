#!/usr/bin/env node
/**
 * Decisão 7 — cria a coleção Universe para "KPop Demon Hunters" (handle
 * kpop-demon-hunters), confirmado pela Tarefa 18 (83,2% de sobreposição). Universo
 * próprio, NÃO toca em demon-slayer.
 *
 * Regra: alterpop.franchise EQUALS "KPop Demon Hunters", templateSuffix
 * "universe-room" (mesma convenção de universeCollections.server.js). Cria em
 * RASCUNHO — nunca publica em canal de vendas.
 *
 * DRY-RUN por defeito (só verifica se a coleção já existe). `--execute` cria.
 *
 * Correr na Fly:  node scripts/catalog/kpop-collection-create.js
 *                 node scripts/catalog/kpop-collection-create.js --execute
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { getUniverseByHandle, UNIVERSE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseUniverses.js";
import { ALTERPOP_FRANCHISE_DEFINITION_GID } from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const HANDLE = "kpop-demon-hunters";

const COLL_QUERY = `query K_Coll($h: String!){ collectionByHandle(handle: $h){ id handle title templateSuffix ruleSet{ rules{ column relation condition } } } }`;
const COLLECTION_CREATE = `
  mutation K_Create($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle title templateSuffix }
      userErrors { field message }
    }
  }
`;

async function main() {
  const universe = getUniverseByHandle(HANDLE);
  if (!universe) {
    console.error(`✗ handle "${HANDLE}" não está em franchiseUniverses.js — corre depois da Decisão 7 estar mergeada.`);
    process.exit(1);
  }

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  console.log(`\n=== kpop-collection-create (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===\n`);

  const existing = (await client.graphql(COLL_QUERY, { h: HANDLE })).collectionByHandle;
  if (existing) {
    console.log(`já existe: ${existing.id}  templateSuffix=${existing.templateSuffix || "∅"}  rule=${JSON.stringify(existing.ruleSet?.rules?.[0])}`);
    console.log("nada a fazer.");
    return;
  }

  console.log(`coleção "${HANDLE}" não existe.`);
  console.log(`  título:         ${universe.name}`);
  console.log(`  templateSuffix: ${UNIVERSE_TEMPLATE_SUFFIX}`);
  console.log(`  regra:          alterpop.franchise EQUALS "${universe.name}"`);

  if (!EXECUTE) {
    console.log(`\n(dry-run — nada criado. Para criar: --execute)`);
    return;
  }

  const data = await client.graphql(COLLECTION_CREATE, {
    input: {
      title: universe.name,
      handle: universe.handle,
      templateSuffix: UNIVERSE_TEMPLATE_SUFFIX,
      ruleSet: {
        appliedDisjunctively: false,
        rules: [
          {
            column: "PRODUCT_METAFIELD_DEFINITION",
            relation: "EQUALS",
            condition: universe.name,
            conditionObjectId: ALTERPOP_FRANCHISE_DEFINITION_GID,
          },
        ],
      },
      descriptionHtml: `Coleção Universe — produtos com alterpop.franchise = "${universe.name}". Rascunho: confirmar e publicar no Admin.`,
    },
  });
  const errs = data.collectionCreate?.userErrors || [];
  if (errs.length || !data.collectionCreate?.collection?.id) {
    console.error(`✗ falhou: ${errs.map((e) => e.message).join("; ")}`);
    process.exit(1);
  }
  console.log(`\n✓ criada (rascunho, não publicada): ${JSON.stringify(data.collectionCreate.collection)}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
