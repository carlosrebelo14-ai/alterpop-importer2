#!/usr/bin/env node
/**
 * Fase 7 — plano das coleções Universe. DRY-RUN por defeito (não escreve nada).
 *
 *   node scripts/catalog/universe-collections-plan.js              # dry-run
 *   node scripts/catalog/universe-collections-plan.js --create     # cria as `toCreate` (rascunho)
 *   node scripts/catalog/universe-collections-plan.js --create --adopt star-wars,one-piece
 *        # + adota (collectionUpdate: regra alterpop.franchise + templateSuffix) as coleções
 *          existentes desses universos
 *
 * Precisa de sessão OAuth offline (correr na Fly).
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  planUniverseCollections,
  createUniverseCollections,
} from "../../lib/importer/shopify/universeCollections.server.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const CREATE = has("--create");
const ADOPT = valOf("--adopt", "").split(",").map((s) => s.trim()).filter(Boolean);
const SHOP = valOf("--shop", process.env.SPOT_CHECK_SHOP || "jyr17t-wr.myshopify.com");

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const plan = await planUniverseCollections(client);
  console.log(`=== universe-collections-plan (${SHOP}) ===`);
  console.log(`coleções na loja: ${plan.existingCount}\n`);

  console.log(`-- toCreate (${plan.toCreate.length}) — criar nova (rascunho, regra alterpop.franchise EQUALS) --`);
  for (const u of plan.toCreate) console.log(`  ${u.handle.padEnd(24)} "${u.name}"  baseline ${u.baseline}`);

  console.log(`\n-- toAdopt (${plan.toAdopt.length}) — já existe coleção com título equivalente --`);
  for (const u of plan.toAdopt) {
    const e = u.existing;
    console.log(`  ${u.handle.padEnd(20)} "${u.name}"  ->  "${e.title}" (${e.handle}, regra ${e.ruleColumn}, tpl ${e.templateSuffix || "—"}, ${e.productsCount} prod)`);
  }

  console.log(`\n-- dormentes (não criar, baseline < 10) --`);
  for (const u of plan.dormant) console.log(`  ${u.handle.padEnd(16)} "${u.name}"  baseline ${u.baseline}`);

  if (!CREATE) {
    console.log(`\nDRY-RUN — nada escrito. Usa --create (e opcionalmente --adopt <handles>) para executar.`);
    return;
  }

  console.log(`\n=== a executar: criar ${plan.toCreate.length}${ADOPT.length ? ` + adotar ${ADOPT.length}` : ""} ===`);
  const res = await createUniverseCollections(client, { adoptHandles: ADOPT });
  console.log(`criadas: ${res.created.length}`);
  res.created.forEach((c) => console.log(`  ${c.handle}  ${c.id}`));
  if (res.adopted.length) {
    console.log(`adotadas: ${res.adopted.length}`);
    res.adopted.forEach((c) => console.log(`  ${c.handle}  ${c.id}`));
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
