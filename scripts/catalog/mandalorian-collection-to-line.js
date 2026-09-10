#!/usr/bin/env node
/**
 * ENTREGA 2 · Tarefa 2 (última linha) — converte a coleção `the-mandalorian` de sala
 * Universe para sala Line.
 *
 *   regra:      alterpop.franchise EQUALS "The Mandalorian"   (universe-room)
 *   passa a:    alterpop.line      EQUALS "The Mandalorian"   (templateSuffix "line")
 *
 * A coleção mantém id/handle/URL. Não publica nem despublica (a loja está vazia; a
 * publicação é manual). NÃO cria a definição alterpop.line — isso é
 * line-metafield-definition.js; este script exige o GID (do módulo ou de --line-gid).
 *
 * DRY-RUN por defeito. `--execute` aplica.
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/mandalorian-collection-to-line.js
 *   node scripts/catalog/mandalorian-collection-to-line.js --execute --line-gid gid://shopify/MetafieldDefinition/123
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { ALTERPOP_LINE_DEFINITION_GID } from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";
import { LINE_TEMPLATE_SUFFIX, getLineByHandle } from "../../lib/importer/catalog/franchiseLines.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const LINE_GID =
  (args.indexOf("--line-gid") >= 0 && args[args.indexOf("--line-gid") + 1]) ||
  ALTERPOP_LINE_DEFINITION_GID;
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const HANDLE = "the-mandalorian";

const FIND = `
  query MandaColl($q: String!) {
    collections(first: 1, query: $q) {
      nodes {
        id handle title templateSuffix
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
    }
  }
`;

const UPDATE = `
  mutation MandaCollUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle templateSuffix ruleSet { rules { column relation condition } } }
      userErrors { field message }
    }
  }
`;

async function main() {
  const line = getLineByHandle(HANDLE);
  if (!line) {
    console.error(`franchiseLines.js não tem a Line "${HANDLE}"`);
    process.exit(1);
  }
  if (!LINE_GID) {
    console.error(
      "GID de alterpop.line em falta. Corre scripts/catalog/line-metafield-definition.js,\n" +
      "cola o GID em ALTERPOP_LINE_DEFINITION_GID (ou passa --line-gid)."
    );
    process.exit(1);
  }

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const col = (await client.graphql(FIND, { q: `handle:${HANDLE}` })).collections?.nodes?.[0];
  if (!col) {
    console.error(`coleção "${HANDLE}" não encontrada na loja`);
    process.exit(1);
  }

  console.log(`=== mandalorian-collection-to-line (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===`);
  console.log(`atual : ${col.id}`);
  console.log(`        templateSuffix=${col.templateSuffix || "∅"}`);
  console.log(`        rules=${JSON.stringify(col.ruleSet?.rules || [])}`);

  const nextRuleSet = {
    appliedDisjunctively: false,
    rules: [
      {
        column: "PRODUCT_METAFIELD_DEFINITION",
        relation: "EQUALS",
        condition: line.condition,
        conditionObjectId: LINE_GID,
      },
    ],
  };

  console.log(`\nalvo  : templateSuffix=${LINE_TEMPLATE_SUFFIX}`);
  console.log(`        alterpop.line EQUALS ${JSON.stringify(line.condition)}  (${LINE_GID})`);

  if (!EXECUTE) {
    console.log(`\nDRY-RUN — nada alterado. Corre com --execute.`);
    return;
  }

  const data = await client.graphql(UPDATE, {
    input: { id: col.id, templateSuffix: LINE_TEMPLATE_SUFFIX, ruleSet: nextRuleSet },
  });
  const errs = data.collectionUpdate?.userErrors || [];
  if (errs.length) {
    console.error("userErrors:", JSON.stringify(errs, null, 2));
    process.exit(1);
  }
  console.log(`\n✓ atualizada:`, JSON.stringify(data.collectionUpdate.collection, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
