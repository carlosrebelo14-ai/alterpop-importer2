#!/usr/bin/env node
/**
 * N4, opção A (decisão do Carlos, 29/09/2026) — remove as tags fora da lista permitida
 * (ALLOWED_PRODUCT_TAGS = ["alterpop"], tagAllowlist.js) nos produtos da loja.
 *
 * Dry-run por omissão. Escreve só com --execute, e só com tagsRemove (exceção explícita
 * à regra de escrita, decidida para a opção A). Nunca productUpdate, nunca tagsAdd.
 *
 * RECUSA correr se o código em produção ainda gerar tags fora da lista: o publisher
 * reescreve as tags em cada publicação, e uma limpeza feita antes do deploy era desfeita
 * na republicação seguinte. A sonda carrega o mapper de process.cwd()/lib — no Fly,
 * /app/lib, o código que o servidor está a correr — e não a cópia ao lado deste script
 * (uma pasta de staging podia ter código mais novo do que a produção).
 *
 * Produtos com ociostock.sync_locked=true ficam marcados e DE FORA, a menos que
 * --include-locked (OK explícito do Carlos para esses produtos).
 *
 * Âmbito: ACTIVE por omissão (as 159 do N4). --all-statuses inclui DRAFT e ARCHIVED.
 *
 *   flyctl ssh console -a alterpop-importer-app -C "node scripts/catalog/tags-cleanup.js"
 *   flyctl ssh console -a alterpop-importer-app -C "node scripts/catalog/tags-cleanup.js --execute"
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { fetchProductTags, removeProductTags } from "../../lib/importer/shopify/productTags.server.js";
import {
  ALLOWED_PRODUCT_TAGS,
  findTagsOutsideAllowlist,
  planTagsCleanup,
  probeTagBuilder,
} from "../../lib/importer/shopify/tagAllowlist.js";
import { reportBatchDone } from "../../lib/maintenance/batchReport.js";

const TAG = "tags-cleanup";
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const INCLUDE_LOCKED = args.includes("--include-locked");
const ALL_STATUSES = args.includes("--all-statuses");
const QUERY = ALL_STATUSES ? "" : "status:active";

const fatal = (msg) => {
  console.error(`[${TAG}] FATAL: ${msg}`);
  process.exit(1);
};

/** Sonda do código em produção (process.cwd()/lib). */
async function probeProductionCode() {
  const mapperPath = path.join(process.cwd(), "lib", "importer", "shopify", "shopifyMapper.server.js");
  if (!fs.existsSync(mapperPath)) {
    fatal(`não encontrei o mapper de produção em ${mapperPath}. Correr a partir da raiz da app (no Fly: cd /app).`);
  }
  const prod = await import(pathToFileURL(mapperPath).href);
  if (typeof prod.buildShopifyProductTags !== "function") fatal(`${mapperPath} não exporta buildShopifyProductTags.`);
  return { mapperPath, ...probeTagBuilder(prod.buildShopifyProductTags) };
}

async function main() {
  console.log(
    `=== ${TAG} (${SHOP}) · ${EXECUTE ? "EXECUTE" : "dry-run"} · âmbito ${ALL_STATUSES ? "todos os status" : "ACTIVE"}` +
      ` · permitidas: ${ALLOWED_PRODUCT_TAGS.join(", ")}${INCLUDE_LOCKED ? " · COM sync_locked" : ""} ===`,
  );

  const probe = await probeProductionCode();
  console.log(`\nsonda do código em produção (${probe.mapperPath}): gera [${probe.produced.join(", ")}]`);
  if (!probe.ok) {
    fatal(
      `o código em produção ainda gera tags fora da lista: ${probe.outside.join(", ")}. ` +
        `Fazer deploy (bash scripts/deploy.sh) da lista permitida antes de limpar — senão a próxima publicação repõe-as.`,
    );
  }

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const products = await fetchProductTags(client, QUERY);
  const plan = planTagsCleanup(products, { includeLocked: INCLUDE_LOCKED });
  if (plan.processed !== products.length) fatal(`processed (${plan.processed}) != lidos (${products.length})`);
  const summary = findTagsOutsideAllowlist(products);

  console.log(`\nprodutos lidos: ${products.length} · limpos: ${plan.clean} · a limpar: ${plan.removals.length} (${plan.tagsToRemove} tag(s)) · sync_locked de fora: ${plan.lockedSkipped.length}`);
  console.log(`tags distintas fora da lista: ${summary.distinctTags.length}`);
  for (const t of summary.distinctTags) console.log(`  ${String(t.count).padStart(4)}  ${t.tag}`);

  if (plan.lockedSkipped.length) {
    console.log(`\nsync_locked — NÃO tocados sem --include-locked:`);
    for (const l of plan.lockedSkipped) console.log(`  ${l.sku}  ${l.handle}: ${l.tags.join(", ")}`);
  }

  if (!ALL_STATUSES) {
    const others = await fetchProductTags(client, "status:draft OR status:archived");
    const otherOffenders = findTagsOutsideAllowlist(others).offenders;
    console.log(`\n(fora do âmbito: ${others.length} DRAFT/ARCHIVED, ${otherOffenders.length} com tags fora da lista — --all-statuses para os incluir)`);
  }

  if (!EXECUTE) {
    console.log(`\n[dry-run] por produto:`);
    for (const r of plan.removals) console.log(`  ${r.sku}  ${r.handle}: tagsRemove [${r.tags.join(", ")}]`);
    reportBatchDone({
      tag: TAG,
      itemsRead: products.length,
      processed: plan.processed,
      total: products.length,
      extra: `dry-run, nada escrito · a_limpar=${plan.removals.length} tags=${plan.tagsToRemove} locked=${plan.lockedSkipped.length}`,
    });
    return;
  }

  let done = 0;
  const errors = [];
  for (const r of plan.removals) {
    try {
      await removeProductTags(client, r.productId, r.tags);
      done += 1;
    } catch (err) {
      errors.push({ ...r, message: err?.message || String(err) });
      console.error(`[${TAG}] ERRO ${r.sku} ${r.handle}: ${err?.message || err}`);
    }
  }

  // Releitura: fora dos sync_locked excluídos, não pode sobrar nenhuma tag fora da lista.
  const after = await fetchProductTags(client, QUERY);
  const lockedIds = new Set(plan.lockedSkipped.map((l) => l.productId));
  const leftover = findTagsOutsideAllowlist(after.filter((p) => !lockedIds.has(p.productId)));
  console.log(`\nreleitura: ${after.length} produto(s) · com tags fora da lista (sem contar sync_locked excluídos): ${leftover.offenders.length}`);
  for (const o of leftover.offenders) console.log(`  ${o.sku}  ${o.handle}: ${o.tags.join(", ")}`);

  reportBatchDone({
    tag: TAG,
    itemsRead: plan.removals.length,
    processed: done,
    total: plan.removals.length,
    errorCount: errors.length + leftover.offenders.length,
    extra: `locked_de_fora=${plan.lockedSkipped.length}`,
  });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
