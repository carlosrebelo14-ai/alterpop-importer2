// Ferramenta de manutenção pontual — B15 (briefing 16/09/2026).
//
// buildProductDescriptionHtml (lib/importer/shopify/shopifyMapper.server.js) tinha três
// defeitos na descrição gerada — franchises em bruto do feed em vez de
// alterpop.franchise/alterpop.line, categoryMain podendo mostrar "Clearance", e a
// frase de abertura sempre igual — corrigidos no código. Isso só afeta publish/republish
// daqui para a frente; este script reescreve descriptionHtml nos produtos JÁ publicados.
//
// Fonte da verdade sobre "já publicado" e o shopifyProductId: fila de curadoria
// (curationQueue.server.js), item.status === "PUBLISHED", item.metadata.shopifyProductId
// — a mesma fonte que shopifyApprovedSync.server.js usa (markQueueItemPublished).
//
// Dados do produto (vendor, título final, categorySegments, resolvedFranchise/Line,
// barcode, peso, dimensões) vêm de CatalogProduct (Prisma) pelo par (shop, sku).
// title segue a mesma precedência do publisher: titleOverride ?? cleanTitle ?? title
// (ver comentário em shopifyMapper.server.js mapCatalogProductToShopifyPayload).
//
// Só escreve descriptionHtml — não toca em título, preço, stock, status, tags nem
// metafields. Sem ação irreversível: se a nova descrição estiver errada, corre-se de
// novo depois de mais um ajuste ao gerador.
//
// Uso: node scripts/maintenance/backfill-product-descriptions-b15.mjs [--dry-run] [--limit N]
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { buildProductDescriptionHtml } from "../../lib/importer/shopify/shopifyMapper.server.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";

const DRY_RUN = process.argv.includes("--dry-run");
const limitArgIdx = process.argv.indexOf("--limit");
const LIMIT = limitArgIdx >= 0 ? parseInt(process.argv[limitArgIdx + 1], 10) : null;
const SHOP = process.env.SHOPIFY_SHOP_URL;

const PRODUCT_UPDATE = `
  mutation BackfillDescB15($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id }
      userErrors { field message }
    }
  }
`;

function resolveTitle(row) {
  const titleOverride = String(row.titleOverride || "").trim();
  const cleanTitle = String(row.cleanTitle || "").trim();
  const rawTitle = String(row.title || "").trim();
  return titleOverride || cleanTitle || rawTitle || `Product ${row.sku}`;
}

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_URL not set");
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const published = await listCurationQueueItems("PUBLISHED");
  const targets = published.filter((item) => item.metadata?.shopifyProductId);
  const toProcess = LIMIT ? targets.slice(0, LIMIT) : targets;

  console.log(
    `[backfill-desc-b15] fila PUBLISHED com shopifyProductId: ${targets.length}${LIMIT ? ` (a processar ${toProcess.length}, --limit)` : ""}${DRY_RUN ? " (dry run — nothing written)" : ""}`
  );

  let processed = 0;
  let updated = 0;
  let skippedNoCatalogRow = 0;
  let errorCount = 0;

  for (const item of toProcess) {
    processed += 1;
    const row = await prisma.catalogProduct.findFirst({
      where: { shop: SHOP, sku: item.sku },
    });

    if (!row) {
      skippedNoCatalogRow += 1;
      console.warn(`[backfill-desc-b15] sem linha CatalogProduct para SKU ${item.sku} — não tocado`);
      continue;
    }

    const title = resolveTitle(row);
    const descriptionHtml = buildProductDescriptionHtml({ ...row, title });

    if (DRY_RUN) {
      updated += 1;
    } else {
      const res = await client.graphql(PRODUCT_UPDATE, {
        input: { id: item.metadata.shopifyProductId, descriptionHtml },
      });
      const errs = res.productUpdate?.userErrors || [];
      if (errs.length) {
        errorCount += 1;
        console.error(`[backfill-desc-b15] userErrors em SKU ${item.sku}:`, errs);
      } else {
        updated += 1;
      }
    }

    if (processed % 200 === 0) {
      console.log(
        `[backfill-desc-b15] progresso: processed=${processed}/${toProcess.length} updated=${updated} errors=${errorCount}`
      );
    }
  }

  console.log(
    `[backfill-desc-b15] DONE. processed=${processed} updated=${updated} skipped_no_catalog_row=${skippedNoCatalogRow} errors=${errorCount}${DRY_RUN ? " (dry run — nothing written)" : ""}`
  );
}

main()
  .catch((err) => {
    console.error("[backfill-desc-b15] fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
