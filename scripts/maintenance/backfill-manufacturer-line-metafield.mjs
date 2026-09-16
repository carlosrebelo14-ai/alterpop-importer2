// Ferramenta de manutenção pontual — B6 (briefing backend, 16/09/2026).
//
// manufacturerLineExtractor.server.js só é chamado no publish/republish
// (shopifyProductPublisher.server.js). O backfill de resolvedManufacturerLine na BD
// (manufacturer-line-extract-dryrun.js --execute) não escreve nada na Shopify — este
// script fecha esse gap para os produtos JÁ publicados, escrevendo só o metafield
// alterpop.manufacturer_line via metafieldsSet. NUNCA productUpdate: não toca em
// título, descrição, preço, status, tags nem outro metafield.
//
// Fonte do shopifyProductId: fila de curadoria (curationQueue.server.js),
// item.status === "PUBLISHED" — mesma fonte do backfill do B15
// (backfill-product-descriptions-b15.mjs). Linha (resolvedManufacturerLine) vem de
// CatalogProduct (Prisma) pelo par (shop, sku).
//
// Uso: node scripts/maintenance/backfill-manufacturer-line-metafield.mjs [--dry-run]
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";

const DRY_RUN = process.argv.includes("--dry-run");
const SHOP = process.env.SHOPIFY_SHOP_URL;

const METAFIELDS_SET = `
  mutation BackfillManufacturerLine($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_URL not set");
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const published = await listCurationQueueItems("PUBLISHED");
  const targets = published.filter((item) => item.metadata?.shopifyProductId);

  console.log(
    `[backfill-manufacturer-line] fila PUBLISHED com shopifyProductId: ${targets.length}${DRY_RUN ? " (dry run — nothing written)" : ""}`
  );

  let processed = 0;
  let written = 0;
  let skippedNoLine = 0;
  let skippedNoCatalogRow = 0;
  let errorCount = 0;

  for (const item of targets) {
    processed += 1;
    const row = await prisma.catalogProduct.findFirst({
      where: { shop: SHOP, sku: item.sku },
      select: { resolvedManufacturerLine: true },
    });

    if (!row) {
      skippedNoCatalogRow += 1;
      console.warn(`[backfill-manufacturer-line] sem linha CatalogProduct para SKU ${item.sku} — não tocado`);
      continue;
    }

    const line = String(row.resolvedManufacturerLine || "").trim().normalize("NFC");
    if (!line) {
      skippedNoLine += 1;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[backfill-manufacturer-line] (dry-run) escreveria SKU ${item.sku} -> "${line}"`);
      written += 1;
      continue;
    }

    const res = await client.graphql(METAFIELDS_SET, {
      metafields: [
        {
          ownerId: item.metadata.shopifyProductId,
          namespace: "alterpop",
          key: "manufacturer_line",
          type: "single_line_text_field",
          value: line,
        },
      ],
    });
    const errs = res.metafieldsSet?.userErrors || [];
    if (errs.length) {
      errorCount += 1;
      console.error(`[backfill-manufacturer-line] userErrors em SKU ${item.sku}:`, errs);
    } else {
      written += 1;
      console.log(`[backfill-manufacturer-line] SKU ${item.sku} -> "${line}"`);
    }
  }

  console.log(
    `[backfill-manufacturer-line] DONE. processed=${processed} written=${written} skipped_no_line=${skippedNoLine} skipped_no_catalog_row=${skippedNoCatalogRow} errors=${errorCount}${DRY_RUN ? " (dry run — nothing written)" : ""}`
  );
}

main()
  .catch((err) => {
    console.error("[backfill-manufacturer-line] fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
