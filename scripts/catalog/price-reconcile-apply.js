#!/usr/bin/env node
/**
 * Aplicação da reconciliação de preços dos PUBLISHED (revisão do dry-run, 07/10/2026,
 * passo 6). DRY_RUN=true por omissão: sem `DRY_RUN=false` não escreve nada.
 *
 * Ordem obrigatória (passos 7-8): merge + deploy do PR do pricing, `npm run db:push`,
 * reindex do catálogo, portão de saúde verde — SÓ DEPOIS isto, corrido pelo Carlos.
 * Antes do deploy, o publisher antigo reescrevia o preço com × 1,4 a cada republicação
 * e desfazia o que aqui se escreve. Por isso o script recusa escrever enquanto o
 * catálogo não tiver CatalogProduct.distributorPrice preenchido (sinal de db:push +
 * reindex feitos).
 *
 * - Custo e PVPR vêm do CATÁLOGO (o que o painel mostra), não do feed: painel, publisher
 *   e esta escrita dão o mesmo preço para o mesmo SKU.
 * - Margem: só a gravada nas definições (sem simulação — o que se escreve é o que o
 *   painel mostra).
 * - Classificação em lib/importer/pricing/priceReconcile.server.js, a mesma do dry-run,
 *   recalculada AGORA com o preço live do momento: só escreve "muda" — preço live que
 *   ainda bate com × 1,4. Qualquer outro (editado à mão desde o dry-run, override,
 *   sync_locked, sem dados) salta e fica no relatório.
 * - Imediatamente antes de cada escrita, relê o preço live e o sync_locked dessa
 *   variante: se mudou desde o plano (editado à mão a meio da corrida), salta e reporta.
 * - Depois de escrever, relê o preço live de cada SKU escrito e confirma ao cêntimo.
 * - Erros (escrita e verificação) → results/errors.json (convenção do AGENTS.md).
 *
 * Corre na Fly:
 *   node scripts/catalog/price-reconcile-apply.js                  # dry-run
 *   env DRY_RUN=false node scripts/catalog/price-reconcile-apply.js # escreve
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { resolveMarginPct, PRICE_STATUS } from "../../lib/importer/pricing/pricing.server.js";
import {
  classifyPriceReconcile,
  toReconcileRow,
  reconcileRowsToCsv,
  printReconcileSummary,
} from "../../lib/importer/pricing/priceReconcile.server.js";
import { fetchLiveVariantsBySku, diagnoseMissingLive } from "../../lib/importer/shopify/liveVariantsBySku.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const DRY_RUN = process.env.DRY_RUN !== "false";
const ERRORS_PATH = path.join(process.cwd(), "results", "errors.json");
const PAUSE_MS = 250; // entre escritas — 159 produtos, sem pressa

const VARIANT_PRICE_UPDATE = `
  mutation PriceReconcile($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

const VARIANT_RECHECK = `
  query PriceRecheck($id: ID!) {
    productVariant(id: $id) {
      price
      product { syncLocked: metafield(namespace: "ociostock", key: "sync_locked") { value } }
    }
  }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (v) => Math.round(Number(v) * 100);

/** Acrescenta entradas a results/errors.json (mesmo formato de curationQueue/live-sync-daemon). */
function appendErrors(entries) {
  if (!entries.length) return;
  fs.mkdirSync(path.dirname(ERRORS_PATH), { recursive: true });
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ERRORS_PATH, "utf8"));
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    list = [];
  }
  list.push(...entries);
  fs.writeFileSync(ERRORS_PATH, JSON.stringify(list, null, 2), "utf8");
}

function errorEntry(codigo, sku, mensagem, contexto = {}) {
  return {
    operacao: "price-reconcile-apply",
    codigo,
    mensagem,
    timestamp: new Date().toISOString(),
    contexto: { sku, ...contexto },
  };
}

/**
 * db:push + reindex feitos? A coluna tem de existir e estar preenchida no catálogo.
 * @returns {Promise<{ ok: boolean, reason?: string, filled?: number, total?: number }>}
 */
async function catalogReadiness() {
  const cols = await prisma.$queryRawUnsafe(`PRAGMA table_info("CatalogProduct")`);
  if (!cols.some((c) => c.name === "distributorPrice")) {
    return { ok: false, reason: "CatalogProduct.distributorPrice não existe — falta `npm run db:push` depois do deploy" };
  }
  const [{ total, filled }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS total, COUNT("distributorPrice") AS filled FROM "CatalogProduct" WHERE shop = ?`,
    SHOP
  );
  const t = Number(total);
  const f = Number(filled);
  if (!f) return { ok: false, reason: `distributorPrice vazio em todo o catálogo (${t} linhas) — falta o reindex`, filled: f, total: t };
  return { ok: true, filled: f, total: t };
}

async function main() {
  console.log(`=== price-reconcile-apply (${SHOP}) · ${DRY_RUN ? "DRY-RUN — nada é escrito" : "ESCRITA REAL"} ===\n`);

  const readiness = await catalogReadiness();
  if (!readiness.ok) {
    console.error(`PARADO: ${readiness.reason}.`);
    process.exit(1);
  }
  console.log(`Catálogo: distributorPrice preenchido em ${readiness.filled}/${readiness.total} linhas.`);

  const marginPct = resolveMarginPct(await loadShopSettings(SHOP));
  console.log(`Margem global (definições): ${marginPct}%`);

  const published = (await listCurationQueueItems("PUBLISHED")).filter((i) => i.sku);
  const skus = published.map((i) => i.sku);
  console.log(`PUBLISHED na fila: ${skus.length}`);

  const catalogRows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, sku: { in: skus } },
    select: { sku: true, title: true, netPrice: true, grossPrice: true, distributorPrice: true },
  });
  const catalogBySku = new Map(catalogRows.map((r) => [r.sku, r]));

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const liveBySku = await fetchLiveVariantsBySku(client, skus);
  const missingLiveReasons = await diagnoseMissingLive(
    client,
    published.filter((i) => !liveBySku.has(i.sku))
  );
  console.log(`Em CatalogProduct: ${catalogRows.length} · variantes live: ${liveBySku.size}\n`);

  const rows = published.map((item) => {
    const cat = catalogBySku.get(item.sku);
    const live = liveBySku.get(item.sku);
    const result = classifyPriceReconcile({
      item,
      prices: cat ? { distributorPrice: cat.distributorPrice, grossPrice: cat.grossPrice } : null,
      netPrice: cat?.netPrice,
      live,
      missingLiveReason: missingLiveReasons.get(item.sku),
      marginPct,
    });
    return { ...toReconcileRow({ sku: item.sku, title: cat?.title || live?.title, live, result }), live };
  });

  printReconcileSummary(rows, Object.values(PRICE_STATUS));

  const outDir = path.join(process.cwd(), "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const planFile = path.join(outDir, `price-reconcile-apply-${DRY_RUN ? "dryrun" : "plan"}-${stamp}.csv`);
  fs.writeFileSync(planFile, reconcileRowsToCsv(rows));
  console.log(`\nLista completa: ${planFile}`);

  const toWrite = rows.filter((r) => r.category === "muda");
  if (DRY_RUN) {
    console.log(`\nDRY-RUN: ${toWrite.length} preço(s) seriam escritos. Para escrever: env DRY_RUN=false node scripts/catalog/price-reconcile-apply.js`);
    return;
  }

  console.log(`\nA escrever ${toWrite.length} preço(s)…`);
  const errors = [];
  const written = [];
  const skipped = [];
  for (const r of toWrite) {
    // Compare-and-set: o plano é de há minutos; o preço live tem de ser ainda o mesmo.
    let current;
    try {
      current = (await client.graphql(VARIANT_RECHECK, { id: r.live.variantId })).productVariant;
    } catch (err) {
      errors.push(errorEntry("RECHECK_FAILED", r.sku, err?.message || String(err), { before: r.before, after: r.after }));
      continue;
    }
    if (!current || cents(current.price) !== cents(r.before) || current.product?.syncLocked?.value === "true") {
      const why = !current
        ? "variante desapareceu"
        : current.product?.syncLocked?.value === "true"
          ? "ficou sync_locked"
          : `preço live mudou de ${r.before} para ${current.price}`;
      skipped.push({ sku: r.sku, why });
      continue;
    }
    try {
      const data = await client.graphql(VARIANT_PRICE_UPDATE, {
        productId: r.live.productId,
        variants: [{ id: r.live.variantId, price: r.after.toFixed(2) }],
      });
      const userErrors = data.productVariantsBulkUpdate?.userErrors || [];
      if (userErrors.length) {
        errors.push(errorEntry("WRITE_USER_ERROR", r.sku, userErrors.map((e) => e.message).join("; "), { before: r.before, after: r.after }));
      } else {
        written.push(r);
      }
    } catch (err) {
      errors.push(errorEntry("WRITE_FAILED", r.sku, err?.message || String(err), { before: r.before, after: r.after }));
    }
    await sleep(PAUSE_MS);
  }
  console.log(`Escritos: ${written.length} · saltados (mudaram desde o plano): ${skipped.length} · falhados: ${errors.length}`);
  for (const s of skipped) console.log(`  saltado ${s.sku}: ${s.why}`);

  // Verificação por leitura: o preço live tem de ser, ao cêntimo, o que se escreveu.
  console.log("\nA verificar por leitura…");
  let verifyLive = new Map();
  try {
    verifyLive = await fetchLiveVariantsBySku(client, written.map((r) => r.sku));
  } catch (err) {
    errors.push(errorEntry("VERIFY_READ_FAILED", null, err?.message || String(err), { written: written.length }));
  }
  let verified = 0;
  for (const r of written) {
    const now = verifyLive.get(r.sku);
    if (now && cents(now.price) === cents(r.after)) {
      verified += 1;
      continue;
    }
    errors.push(
      errorEntry("VERIFY_MISMATCH", r.sku, now ? `live ${now.price} ≠ escrito ${r.after}` : "variante não encontrada na releitura", {
        before: r.before,
        after: r.after,
      })
    );
  }
  console.log(`Verificados: ${verified}/${written.length}`);

  appendErrors(errors);
  if (errors.length) {
    console.error(`\n${errors.length} erro(s) — ver ${ERRORS_PATH}:`);
    for (const e of errors) console.error(`  ${e.contexto.sku ?? "—"} ${e.codigo}: ${e.mensagem}`);
    process.exitCode = 1;
  } else {
    console.log("\nSem erros.");
  }
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    appendErrors([errorEntry("FATAL", null, err?.message || String(err))]);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
