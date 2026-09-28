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
 * Plano calculado a partir da loja (P2, sem máximo estático): lê as regras de todas as
 * smart collections e tira do plano, como BLOQUEADA_POR_COLECAO (P1), as definições
 * divergentes que estão em uso numa regra — a Shopify recusaria o update. Reporta-as
 * com os handles; mudar essas exige mexer primeiro nas coleções (decisão própria).
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
  planDefinitionShapeUpdates,
  readMetafieldDefinitionShape,
  readSmartCollectionDefinitionUsage,
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

const describe = (d) =>
  `storefront=${d?.access?.storefront} scc=${d?.capabilities?.smartCollectionCondition?.enabled} pin=${d?.pinnedPosition ?? "-"} type=${d?.type?.name}`;

async function main() {
  console.log(`=== ${TAG} (${SHOP}) · ${EXECUTE ? "EXECUTE" : "dry-run"} ===`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const entries = [];
  for (const def of DEFS) {
    const current = await readMetafieldDefinitionShape(client, def);
    if (!current) {
      console.error(`[${TAG}] FATAL: ${def.namespace}.${def.key} não existe na loja.`);
      process.exit(1);
    }
    entries.push({ def, current });
  }
  const usage = await readSmartCollectionDefinitionUsage(client);
  const { plan, blocked, aligned } = planDefinitionShapeUpdates(entries, usage);

  for (const { def, current } of entries) {
    const inUse = usage.get(current.id) || [];
    const verdict = aligned.some((a) => a.def === def)
      ? "bate com a forma, salta"
      : blocked.some((x) => x.def === def)
        ? "BLOQUEADA_POR_COLECAO"
        : "alinhar";
    console.log(`  ${def.namespace}.${def.key} ${describe(current)} regras=${inUse.length} → ${verdict}`);
  }
  for (const { def, input, collections } of blocked) {
    console.warn(
      `[${TAG}] BLOQUEADA_POR_COLECAO ${def.namespace}.${def.key}: diverge da forma mas está em ${collections.length} regra(s) de smart collection` +
        ` (${collections.slice(0, 10).join(", ")}${collections.length > 10 ? ", …" : ""}). Fora do plano. Input que seria enviado: ${JSON.stringify(input)}`,
    );
  }

  console.log(`\nplano: ${plan.length} a alinhar · ${blocked.length} bloqueada(s) por coleção · ${aligned.length} alinhada(s)`);
  if (plan.length === 0) {
    console.log(`[${TAG}] DONE. nada a fazer${blocked.length ? ` (${blocked.length} bloqueada(s), ver acima)` : ""}`);
    return;
  }

  if (!EXECUTE) {
    for (const { input } of plan) {
      console.log(`  [dry-run] metafieldDefinitionUpdate ${JSON.stringify(input)}`);
    }
    reportBatchDone({ tag: TAG, itemsRead: DEFS.length, processed: plan.length, total: plan.length, extra: `blocked=${blocked.length} dry-run, nada escrito` });
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
    const isBlocked = blocked.some((x) => x.def === def);
    if (!ok && !isBlocked) errorCount += 1;
    console.log(`  ${def.namespace}.${def.key} ${describe(after)} ${ok ? "OK" : isBlocked ? "BLOQUEADA_POR_COLECAO" : "FALHOU"}`);
  }

  reportBatchDone({ tag: TAG, itemsRead: DEFS.length, processed, total: plan.length, errorCount, extra: `blocked=${blocked.length}` });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
