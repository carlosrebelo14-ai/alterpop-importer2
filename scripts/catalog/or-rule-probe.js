#!/usr/bin/env node
/**
 * ENTREGA 2 · Tarefa 7 — testa se a Shopify (plano Basic) aceita uma smart collection
 * com `appliedDisjunctively: true` (OR) e DUAS regras PRODUCT_METAFIELD_DEFINITION.
 *
 * Decide o modelo dos sub-universos Disney (uma sala que agregue várias franquias por
 * OR de metafields). NÃO bloqueia o Mandalorian.
 *
 * Cria uma coleção DESCARTÁVEL (handle prefixado `zzz-or-probe-`), lê de volta o
 * ruleSet, e apaga. `--keep` não apaga (para inspeção manual). Read-mostly: o único
 * efeito é a coleção temporária, removida no fim.
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/or-rule-probe.js
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { ALTERPOP_FRANCHISE_DEFINITION_GID } from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const CREATE = `
  mutation OrProbeCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id handle
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
      userErrors { field message }
    }
  }
`;
const DELETE = `
  mutation OrProbeDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) { deletedCollectionId userErrors { field message } }
  }
`;

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const gid = ALTERPOP_FRANCHISE_DEFINITION_GID;
  const handle = `zzz-or-probe-${Date.now()}`;
  const input = {
    title: "OR probe (descartável)",
    handle,
    ruleSet: {
      appliedDisjunctively: true, // OR
      rules: [
        { column: "PRODUCT_METAFIELD_DEFINITION", relation: "EQUALS", condition: "Frozen", conditionObjectId: gid },
        { column: "PRODUCT_METAFIELD_DEFINITION", relation: "EQUALS", condition: "Toy Story", conditionObjectId: gid },
      ],
    },
  };

  console.log(`=== or-rule-probe (${SHOP}) ===`);
  console.log(`a criar coleção OR com 2 regras PRODUCT_METAFIELD_DEFINITION (franchise EQUALS Frozen OR Toy Story)…`);

  const data = await client.graphql(CREATE, { input });
  const errs = data.collectionCreate?.userErrors || [];
  const col = data.collectionCreate?.collection;

  if (errs.length) {
    console.log(`\n✗ RECUSADO no plano Basic:`);
    for (const e of errs) console.log(`  - ${e.field?.join(".") || ""}: ${e.message}`);
    console.log(`\n→ sub-universos Disney NÃO podem usar OR de metafields nesta loja.`);
    process.exit(0);
  }

  console.log(`\n✓ ACEITE: ${col.id}`);
  console.log(`  appliedDisjunctively: ${col.ruleSet?.appliedDisjunctively}`);
  console.log(`  rules: ${JSON.stringify(col.ruleSet?.rules, null, 2)}`);
  console.log(`\n→ sub-universos Disney PODEM usar OR de metafields.`);

  if (KEEP) {
    console.log(`\n--keep: coleção ${handle} deixada na loja para inspeção. Apaga à mão depois.`);
    return;
  }
  const del = await client.graphql(DELETE, { input: { id: col.id } });
  const delErrs = del.collectionDelete?.userErrors || [];
  if (delErrs.length) {
    console.warn(`\n⚠️ falha a apagar a coleção-teste ${handle}: ${delErrs.map((e) => e.message).join("; ")} — apaga à mão.`);
  } else {
    console.log(`\n(coleção-teste ${handle} apagada)`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
