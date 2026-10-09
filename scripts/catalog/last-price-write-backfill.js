#!/usr/bin/env node
/**
 * Preenchimento inicial da última escrita de preço dos PUBLICADOS (briefing "Aplicar aos
 * publicados", passo 2). Grava item.metadata.lastPriceWrite com o preço live atual como
 * último preço escrito pela app e a margem ESTIMADA pela regra.
 *
 * Pressuposto: nenhum dos publicados atuais tem preço manual. A lista do dry-run mostra,
 * por SKU, o preço live, a margem estimada (intervalo, a regra sobe em degraus de ,50/,90)
 * e os avisos. O Carlos confirma a lista antes de gravar.
 *
 * DRY-RUN por omissão: só lê (fila, Shopify, catálogo). Nada é escrito.
 *   node scripts/catalog/last-price-write-backfill.js
 * Gravar (só com OK do Carlos, depois de ler a lista):
 *   node scripts/catalog/last-price-write-backfill.js --execute [--assume-margin 20] [--skip SKU1,SKU2]
 * --skip exclui SKUs da gravação (ex.: um preço que se sabe ser manual).
 * --assume-margin N grava N como margem de origem nos SKUs cujo preço live N reproduz
 *   (a margem global que se sabe ter estado ativa na altura). Também vale no dry-run.
 * Escrita na fila apenas — não toca na Shopify. Recusa gravar com a indexação a correr.
 * Erros → results/errors.json.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems, recordLastPriceWrites } from "../../lib/curation/curationQueue.server.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { resolveMarginPct } from "../../lib/importer/pricing/pricing.server.js";
import { readCatalogRebuildStatus } from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { fetchLiveVariantsBySku } from "../../lib/importer/shopify/liveVariantsBySku.server.js";
import { planLastWriteBackfill } from "../../lib/importer/pricing/lastWriteBackfill.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const skipIdx = args.indexOf("--skip");
const SKIP = new Set(skipIdx >= 0 ? String(args[skipIdx + 1] || "").split(",").map((s) => s.trim()).filter(Boolean) : []);
const amIdx = args.indexOf("--assume-margin");
const ASSUME = amIdx >= 0 ? Number(args[amIdx + 1]) : null;
if (amIdx >= 0 && !Number.isFinite(ASSUME)) {
  console.error("PARADO: --assume-margin precisa de um número (ex.: 20).");
  process.exit(1);
}
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const ERRORS_PATH = path.join(process.cwd(), "results", "errors.json");

function appendError(entry) {
  fs.mkdirSync(path.dirname(ERRORS_PATH), { recursive: true });
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ERRORS_PATH, "utf8"));
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    list = [];
  }
  list.push({ operacao: "last-price-write-backfill", timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(ERRORS_PATH, JSON.stringify(list, null, 2), "utf8");
}

const eur = (n) => (n == null ? "—" : Number(n).toFixed(2));

async function main() {
  console.log(`=== last-price-write-backfill (${SHOP})${EXECUTE ? " · EXECUTE" : " · DRY-RUN — nada é escrito"} ===\n`);

  if (EXECUTE) {
    const status = await readCatalogRebuildStatus(SHOP);
    if (status?.indexing || status?.state === "running") {
      console.error("PARADO: indexação a correr — o worker trabalha sobre uma cópia da fila e desfazia a gravação.");
      process.exit(1);
    }
  }

  const items = await listCurationQueueItems("PUBLISHED");
  console.log(`PUBLISHED na fila: ${items.length}`);
  const skus = items.map((i) => i.sku);
  const globalPct = resolveMarginPct(await loadShopSettings(SHOP));

  const catalogRows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, sku: { in: skus } },
    select: { sku: true, distributorPrice: true, grossPrice: true },
  });
  const catalogBySku = new Map(catalogRows.map((r) => [r.sku, r]));

  const client = createShopifyClientFromSession(await loadOfflineSessionForShop(SHOP));
  const liveBySku = await fetchLiveVariantsBySku(client, skus); // lança se um chunk falhar

  const plan = planLastWriteBackfill({ items, liveBySku, catalogBySku, globalPct, skip: SKIP, assumeMargin: ASSUME });
  console.log(`Margem global atual: ${globalPct} %\n`);

  const record = plan.filter((r) => r.action === "RECORD");
  const skipped = plan.filter((r) => r.action === "SKIP");

  console.log(`## A GRAVAR (${record.length})`);
  console.log("SKU             live    regra-agora  custo   PVPR    margem estimada          estado      aviso");
  for (const r of record) {
    const rng = r.range ? ` (${r.range[0]}–${r.range[1]})` : "";
    const m = r.marginPct == null ? `desconhecida${rng}` : `${r.marginPct}${r.assumed ? " assumida" : ""}${r.ambiguous ? rng : ""}`;
    console.log(
      `${r.sku.padEnd(15)} ${eur(r.livePrice).padStart(6)}  ${eur(r.ruleNow).padStart(10)}  ${eur(r.cost).padStart(6)}  ${eur(r.pvpr).padStart(6)}  ${m.padEnd(24)}  ${(r.priceStatus || "—").padEnd(10)}  ${r.reason || ""}`
    );
  }
  console.log(`\n## NÃO GRAVADOS (${skipped.length})`);
  for (const r of skipped) console.log(`${r.sku.padEnd(15)} ${r.reason}`);

  const dif = record.filter((r) => r.ruleNow != null && Math.round(r.ruleNow * 100) !== Math.round(r.livePrice * 100)).length;
  console.log(`\n${dif} dos ${record.length} a gravar têm hoje preço live ≠ regra — seriam o âmbito da ação "aplicar aos publicados".`);

  if (!EXECUTE) {
    console.log("\nDRY-RUN: nada gravado. Confirma a lista; para gravar: --execute (e --skip SKU,SKU para excluir).");
    return;
  }
  const result = await recordLastPriceWrites(record.map((r) => ({ sku: r.sku, write: r.write })));
  for (const sku of result.missing) appendError({ codigo: "SKU_FORA_DA_FILA", mensagem: "SKU saiu da fila entre a leitura e a gravação", contexto: { sku } });
  console.log(`\nGravados: ${result.recorded.length} · fora da fila: ${result.missing.length}`);
}

main()
  .catch((err) => {
    appendError({ codigo: "FALHA", mensagem: err?.message || String(err) });
    console.error("Erro:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect?.());
