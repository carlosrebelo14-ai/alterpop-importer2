#!/usr/bin/env node
/**
 * PR 4 — backfill da tabela ProductCharacter.
 *   B1  --mode store     ligações já escritas em alterpop.character na loja, origem "store".
 *   B2  --mode resolver  resolver sobre todos os produtos ACTIVE, origem "resolver".
 *
 * DRY-RUN por omissão. `--execute` grava no Prisma. Nunca escreve na Shopify.
 * Dry-run de B2 imprime produto → personagens. Sai com erro se o total de linhas não bater.
 *
 * Correr na Fly:  node scripts/catalog/character-links-backfill.js --mode store
 *                 node scripts/catalog/character-links-backfill.js --mode resolver [--execute]
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  planProductCharacterLinks,
  storeLinkRows,
  productToCharactersReport,
} from "../../lib/importer/catalog/productCharacterLinks.js";
import {
  loadLinkInputs,
  loadExistingLinks,
  loadActiveAndStoreHandles,
  applyLinkPlan,
  upsertStoreRows,
} from "../../lib/importer/shopify/productCharacterLinks.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const modeArg = args.find((a) => a.startsWith("--mode="))?.slice("--mode=".length) ?? args[args.indexOf("--mode") + 1];
const MODE = modeArg;
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

async function runStore(client) {
  const { storeHandlesBySku } = await loadActiveAndStoreHandles(client);
  const rows = storeLinkRows(
    [...storeHandlesBySku.entries()].map(([sku, handles]) => ({ sku, handles })),
  );
  const withChar = [...storeHandlesBySku.values()].filter((h) => h.length).length;
  console.log(`produtos ACTIVE com alterpop.character na loja: ${withChar}`);
  console.log(`linhas store a gravar: ${rows.length}`);
  for (const r of rows.slice(0, 50)) console.log(`  ${r.sku}  ${r.characterHandle}`);
  if (EXECUTE) {
    const written = await upsertStoreRows(SHOP, rows);
    if (written !== rows.length) throw new Error(`escritas ${written} de ${rows.length} — parar`);
    console.log(`gravadas ${written} linhas origem store`);
  } else {
    console.log("(nada escrito — dry-run)");
  }
}

async function runResolver(client) {
  const { activeSkus } = await loadActiveAndStoreHandles(client);
  const inputs = await loadLinkInputs(SHOP, activeSkus);
  const existing = await loadExistingLinks(SHOP, activeSkus);
  const plan = planProductCharacterLinks({ products: inputs, existingLinks: existing });
  const report = productToCharactersReport(plan);
  const toAdd = plan.reduce((n, p) => n + p.add.length, 0);
  const toRemove = plan.reduce((n, p) => n + p.remove.length, 0);

  console.log(`produtos ACTIVE: ${activeSkus.length} · com Prisma: ${inputs.length}`);
  console.log(`produtos com personagem (resolver): ${report.length}`);
  console.log(`ligações a acrescentar: ${toAdd} · a remover (origem resolver): ${toRemove}`);
  for (const r of report) console.log(`  ${r.sku}  →  [${r.characters.join(", ")}]`);
  if (inputs.length !== activeSkus.length) {
    console.log(`AVISO: ${activeSkus.length - inputs.length} SKU(s) ACTIVE sem linha no Prisma`);
  }

  if (EXECUTE) {
    const { added, removed } = await applyLinkPlan(SHOP, plan);
    if (added !== toAdd || removed !== toRemove) {
      throw new Error(`escritas (${added}/${removed}) não batem com o plano (${toAdd}/${toRemove})`);
    }
    console.log(`gravadas ${added} ligações, removidas ${removed}`);
  } else {
    console.log("(nada escrito — dry-run)");
  }
}

async function main() {
  if (MODE !== "store" && MODE !== "resolver") {
    throw new Error("uso: --mode store|resolver [--execute]");
  }
  console.log(`\n=== character-links-backfill (${SHOP}) · ${MODE} · ${EXECUTE ? "--execute" : "DRY-RUN"} ===\n`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  if (MODE === "store") await runStore(client);
  else await runResolver(client);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
