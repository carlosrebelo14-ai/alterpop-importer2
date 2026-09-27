#!/usr/bin/env node
/**
 * Briefing 27/09 — alinha alterpop.format e alterpop.franchise com a forma declarada
 * em franchiseMetafieldDefinition.js (access.storefront + smartCollectionCondition).
 *
 * História (27/09):
 *   - format passou a PUBLIC_READ, mas o update só com `access` desligou em silêncio o
 *     smartCollectionCondition. O helper leva agora SEMPRE os dois campos.
 *   - franchise ficou em NONE: a Shopify recusa qualquer update a uma definição usada
 *     em regra de smart collection (coleções Universe). C8 fecha pela opção D.
 *
 * Dry-run por omissão. Escreve só com --execute.
 * Idempotente: salta o que já bate com a forma. Plano vazio = nada a fazer, sai OK.
 * Travão: o plano não pode passar de MAX_CHANGES — acima disso pára sem escrever.
 * Depois do --execute relê as definições e reporta acesso e capability.
 *
 *   flyctl ssh console -a alterpop-importer-app \
 *     -C "node scripts/catalog/ensure-storefront-access.js"
 *   flyctl ssh console -a alterpop-importer-app \
 *     -C "node scripts/catalog/ensure-storefront-access.js --execute"
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  buildDefinitionShapeUpdateInput,
  readMetafieldDefinitionShape,
  updateMetafieldDefinitionShape,
} from "../../lib/importer/shopify/metafieldSetup.js";
import {
  ALTERPOP_FRANCHISE_DEFINITION,
  ALTERPOP_FORMAT_DEFINITION,
} from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";
import { reportBatchDone } from "../../lib/maintenance/batchReport.js";

const TAG = "ensure-storefront-access";
const EXECUTE = process.argv.includes("--execute");
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const DEFS = [ALTERPOP_FRANCHISE_DEFINITION, ALTERPOP_FORMAT_DEFINITION];
const MAX_CHANGES = 1;

const describe = (d) =>
  `storefront=${d?.access?.storefront} scc=${d?.capabilities?.smartCollectionCondition?.enabled} pin=${d?.pinnedPosition ?? "-"} type=${d?.type?.name}`;

async function main() {
  console.log(`=== ${TAG} (${SHOP}) · ${EXECUTE ? "EXECUTE" : "dry-run"} ===`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const plan = [];
  for (const def of DEFS) {
    const current = await readMetafieldDefinitionShape(client, def);
    if (!current) {
      console.error(`[${TAG}] FATAL: ${def.namespace}.${def.key} não existe na loja.`);
      process.exit(1);
    }
    const input = buildDefinitionShapeUpdateInput(def, current);
    console.log(`  ${def.namespace}.${def.key} ${describe(current)} → ${input ? "alinhar" : "bate com a forma, salta"}`);
    if (input) plan.push({ def, input });
  }

  console.log(`\nplano: ${plan.length} definição(ões) a alinhar (máximo ${MAX_CHANGES})`);
  if (plan.length > MAX_CHANGES) {
    console.error(`[${TAG}] FATAL: plano com ${plan.length} > ${MAX_CHANGES}. Nada escrito.`);
    process.exit(1);
  }
  if (plan.length === 0) {
    console.log(`[${TAG}] DONE. nada a fazer`);
    return;
  }

  if (!EXECUTE) {
    for (const { input } of plan) {
      console.log(`  [dry-run] metafieldDefinitionUpdate ${JSON.stringify(input)}`);
    }
    reportBatchDone({ tag: TAG, itemsRead: DEFS.length, processed: plan.length, total: plan.length, extra: "dry-run, nada escrito" });
    return;
  }

  let processed = 0;
  let errorCount = 0;
  for (const { input } of plan) {
    try {
      await updateMetafieldDefinitionShape(client, input);
      processed += 1;
    } catch (err) {
      errorCount += 1;
      console.error(`[${TAG}] ERRO: ${err.message}`);
    }
  }

  console.log(`\nreleitura:`);
  for (const def of DEFS) {
    const after = await readMetafieldDefinitionShape(client, def);
    const ok = buildDefinitionShapeUpdateInput(def, after) === null;
    if (!ok) errorCount += 1;
    console.log(`  ${def.namespace}.${def.key} ${describe(after)} ${ok ? "OK" : "FALHOU"}`);
  }

  reportBatchDone({ tag: TAG, itemsRead: DEFS.length, processed, total: plan.length, errorCount });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
