#!/usr/bin/env node
/**
 * B18 item 5 (briefing backend, 17/09/2026) — live-title-reconcile.js.
 *
 * Caminho próprio para corrigir TÍTULOS já live. publishedStockSync nunca chama
 * productUpdate, por desenho (stock e só stock) — este script é o único caminho que
 * escreve title na loja fora da via APPROVED normal do publisher.
 *
 * DRY-RUN por omissão. `--execute` grava, e SÓ o campo `title` via productUpdate —
 * nunca vendor/descriptionHtml/status/tags/category, nunca handle.
 *
 * Regra de segurança (P4, ADENDA 3, 17/09/2026) — `CatalogProduct.lastPublishedTitle`
 * vazio NÃO é seguro por omissão: não sabemos se o Carlos editou esse título à mão,
 * simplesmente nunca registámos nada. Sem baseline, o produto é SALTADO e reportado,
 * a menos que o SKU venha explicitamente em `--sku` (autorização humana caso a caso).
 * Só quando `lastPublishedTitle` está preenchido E é igual ao título live é que o
 * produto conta como seguro para reconciliar sem `--sku`.
 *
 * `--baseline-from-live [--execute]`: modo separado, nunca junto com a reconciliação
 * normal. Grava `lastPublishedTitle` = título ATUAL na loja para todos os ACTIVE — só
 * depois do Carlos confirmar que não editou nenhum título à mão (D1, ADENDA 4). Nunca
 * toca na Shopify, só no Prisma.
 *
 * Não resolve TITLE_DUPLICATE genuíno de feed (os dois "Star Wars Luke Skywalker" têm
 * originalTitle byte-a-byte igual — o esperado já É o live, não há para onde
 * reconciliar). Isso é decisão de curadoria, não deste script.
 *
 * Correr na Fly:
 *   node scripts/catalog/live-title-reconcile.js
 *   node scripts/catalog/live-title-reconcile.js --sku 889698744041
 *   node scripts/catalog/live-title-reconcile.js --execute --sku 889698744041
 *   node scripts/catalog/live-title-reconcile.js --baseline-from-live
 *   node scripts/catalog/live-title-reconcile.js --baseline-from-live --execute
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";
import { buildPublishPayload } from "../../lib/importer/shopify/shopifyMapper.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const BASELINE = args.includes("--baseline-from-live");

const skuIdx = args.indexOf("--sku");
const SKU_ALLOWLIST =
  skuIdx >= 0 && args[skuIdx + 1]
    ? new Set(
        args[skuIdx + 1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null;

const ACTIVE_PRODUCTS_QUERY = `
  query ReconcileActive($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        variants(first: 1) { nodes { sku } }
      }
    }
  }
`;

const TITLE_UPDATE = `
  mutation ReconcileTitleUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title }
      userErrors { field message }
    }
  }
`;

async function fetchAllActive(client) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(ACTIVE_PRODUCTS_QUERY, { cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) out.push(n);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

async function runBaseline(activeNodes) {
  console.log(`(modo baseline-from-live — nunca toca na Shopify, só grava lastPublishedTitle no Prisma)\n`);

  let wouldSet = 0;
  let alreadySet = 0;
  let skippedNoCatalogRow = 0;
  const toSet = [];

  for (const node of activeNodes) {
    const sku = node.variants?.nodes?.[0]?.sku || null;
    if (!sku) continue;

    const row = await prisma.catalogProduct.findFirst({ where: { shop: SHOP, sku } });
    if (!row) {
      skippedNoCatalogRow += 1;
      continue;
    }

    if (row.lastPublishedTitle === node.title) {
      alreadySet += 1;
      continue;
    }

    wouldSet += 1;
    toSet.push({ sku, handle: node.handle, from: row.lastPublishedTitle, to: node.title });

    if (EXECUTE) {
      await safePrisma(
        "liveTitleReconcile.baseline",
        () =>
          prisma.catalogProduct.update({
            where: { shop_sku: { shop: SHOP, sku } },
            data: { lastPublishedTitle: node.title },
          }),
        { rethrow: false }
      );
    }
  }

  if (toSet.length) {
    console.log(`── ${EXECUTE ? "lastPublishedTitle gravado" : "lastPublishedTitle seria gravado"} (${toSet.length}) ──`);
    for (const t of toSet) {
      console.log(`  ${t.sku}  ${t.handle}`);
      console.log(`    de: ${JSON.stringify(t.from)}`);
      console.log(`    para: ${JSON.stringify(t.to)}`);
    }
    console.log();
  }

  console.log(
    `=== DONE (baseline). ativos=${activeNodes.length} já_tinha_baseline=${alreadySet} ` +
      `sem_linha_prisma=${skippedNoCatalogRow} ${EXECUTE ? "gravados" : "a_gravar"}=${wouldSet} ===`
  );
  if (!EXECUTE && wouldSet > 0) {
    console.log(`\n(nada escrito — dry-run. Corre com --execute depois da confirmação do Carlos.)`);
  }
}

async function runReconcile(client, activeNodes) {
  let alreadyCorrect = 0;
  let skippedNoCatalogRow = 0;
  let manualEditSkipped = 0;
  let noBaselineSkipped = 0;
  let toReconcile = 0;
  let updated = 0;
  const manualEdits = [];
  const noBaseline = [];
  const reconciled = [];

  for (const node of activeNodes) {
    const sku = node.variants?.nodes?.[0]?.sku || null;
    if (!sku) continue;

    const row = await prisma.catalogProduct.findFirst({ where: { shop: SHOP, sku } });
    if (!row) {
      skippedNoCatalogRow += 1;
      continue;
    }

    const payload = await buildPublishPayload(row);
    const desired = payload.title;
    const live = node.title;

    if (desired === live) {
      alreadyCorrect += 1;
      continue;
    }

    const authorized = SKU_ALLOWLIST?.has(sku);
    const lastPublished = row.lastPublishedTitle;

    if (!authorized) {
      if (!lastPublished) {
        noBaselineSkipped += 1;
        noBaseline.push({ sku, handle: node.handle, live, desired });
        continue;
      }
      if (lastPublished !== live) {
        manualEditSkipped += 1;
        manualEdits.push({ sku, handle: node.handle, live, lastPublished, desired });
        continue;
      }
    }

    toReconcile += 1;
    reconciled.push({ sku, handle: node.handle, id: node.id, live, desired, viaSku: authorized });

    if (EXECUTE) {
      const data = await client.graphql(TITLE_UPDATE, { input: { id: node.id, title: desired } });
      const errors = data.productUpdate?.userErrors || [];
      if (errors.length) {
        console.error(`  ✗ ${sku} (${node.handle}): ${errors.map((e) => e.message).join("; ")}`);
        continue;
      }
      await safePrisma(
        "liveTitleReconcile.lastPublishedTitle",
        () =>
          prisma.catalogProduct.update({
            where: { shop_sku: { shop: SHOP, sku } },
            data: { lastPublishedTitle: desired },
          }),
        { rethrow: false }
      );
      updated += 1;
    }
  }

  if (noBaseline.length) {
    console.log(`── sem lastPublishedTitle (baseline em falta), SALTADOS (${noBaseline.length}) ──`);
    console.log(`   (usa --sku <sku1,sku2,...> para autorizar caso a caso)`);
    for (const n of noBaseline) {
      console.log(`  ${n.sku}  ${n.handle}`);
      console.log(`    live:            ${JSON.stringify(n.live)}`);
      console.log(`    seria (ignorado):${JSON.stringify(n.desired)}`);
    }
    console.log();
  }

  if (manualEdits.length) {
    console.log(`── edição manual detetada, SALTADOS (${manualEdits.length}) ──`);
    for (const m of manualEdits) {
      console.log(`  ${m.sku}  ${m.handle}`);
      console.log(`    live:            ${JSON.stringify(m.live)}`);
      console.log(`    lastPublished:   ${JSON.stringify(m.lastPublished)}`);
      console.log(`    seria (ignorado):${JSON.stringify(m.desired)}`);
    }
    console.log();
  }

  if (reconciled.length) {
    console.log(`── ${EXECUTE ? "atualizados" : "seriam atualizados"} (${reconciled.length}) ──`);
    for (const r of reconciled) {
      console.log(`  ${r.sku}  ${r.handle}${r.viaSku ? "  (autorizado via --sku)" : ""}`);
      console.log(`    live:  ${JSON.stringify(r.live)}`);
      console.log(`    novo:  ${JSON.stringify(r.desired)}`);
    }
    console.log();
  }

  console.log(
    `=== DONE. ativos=${activeNodes.length} já_correto=${alreadyCorrect} sem_linha_prisma=${skippedNoCatalogRow} ` +
      `sem_baseline_saltados=${noBaselineSkipped} edicao_manual_saltados=${manualEditSkipped} ` +
      `${EXECUTE ? "atualizados" : "a_reconciliar"}=${EXECUTE ? updated : toReconcile} ===`
  );
  if (!EXECUTE && toReconcile > 0) {
    console.log(`\n(nada escrito — dry-run. Corre com --execute depois da aprovação do Carlos.)`);
  }
}

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  console.log(
    `\n=== live-title-reconcile (${SHOP}) · ${BASELINE ? "BASELINE-FROM-LIVE" : "RECONCILE"} · ${EXECUTE ? "EXECUTE" : "DRY-RUN"} ===\n`
  );

  const activeNodes = await fetchAllActive(client);
  console.log(`produtos ACTIVE: ${activeNodes.length}\n`);

  if (BASELINE) {
    await runBaseline(activeNodes);
  } else {
    await runReconcile(client, activeNodes);
  }
}

main()
  .catch((err) => {
    console.error("[live-title-reconcile] fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
