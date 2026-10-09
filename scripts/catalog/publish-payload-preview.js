#!/usr/bin/env node
/**
 * SÓ LEITURA, NÃO ENVIA NADA À SHOPIFY. Imprime o payload FINAL que o publisher enviaria
 * para um SKU, pelos dois caminhos reais:
 *   - produto novo:      mapped.graphql.product  (o input do productCreate)
 *   - produto existente: buildProductUpdateInput  (o input do productUpdate — substitui as tags)
 * com o campo `tags` à vista. Usa as mesmas funções que o publisher (mapForPublish,
 * buildProductUpdateInput), a linha do catálogo e a entrada da fila do SKU.
 * Não faz nenhuma chamada ao Admin da Shopify nem grava na fila ou no catálogo (o mapeamento
 * pode chamar o serviço de tradução, como o publisher).
 *
 *   node scripts/catalog/publish-payload-preview.js 889698135504
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { getCurationQueueEntry } from "../../lib/curation/curationQueue.server.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { resolveMarginPct, productMarginPct } from "../../lib/importer/pricing/pricing.server.js";
import { mapForPublish, buildProductUpdateInput } from "../../lib/importer/shopify/shopifyProductPublisher.server.js";
import { ALLOWED_PRODUCT_TAGS } from "../../lib/importer/shopify/tagAllowlist.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const sku = process.argv[2];
if (!sku) {
  console.error("Uso: node scripts/catalog/publish-payload-preview.js <sku>");
  process.exit(1);
}

const show = (title, obj) => console.log(`\n--- ${title}\n${JSON.stringify(obj, null, 2)}`);

async function main() {
  console.log(`=== publish-payload-preview ${sku} (${SHOP}) · SÓ LEITURA, NADA É ENVIADO ===`);
  const row = await prisma.catalogProduct.findFirst({ where: { shop: SHOP, sku } });
  if (!row) throw new Error(`SKU ${sku} não está no catálogo indexado`);
  const queueEntry = await getCurationQueueEntry(sku);
  const marginPct = productMarginPct(resolveMarginPct(await loadShopSettings(SHOP)), queueEntry);

  show("Linha do catálogo (campos que alimentam categorias/marca)", {
    vendor: row.vendor,
    categoryMain: row.categoryMain,
    categorySegments: row.categorySegments,
    franchises: row.franchises,
  });
  console.log(`\nEstado na fila: ${queueEntry?.status ?? "—"} · produto Shopify guardado: ${queueEntry?.metadata?.shopifyProductId ?? "—"}`);

  const mapped = await mapForPublish(row, { marginPct, queueEntry });

  const create = mapped.graphql.product;
  show("PRODUTO NOVO — input do productCreate", create);
  const update = buildProductUpdateInput(mapped, queueEntry?.metadata?.shopifyProductId || "gid://shopify/Product/<EXISTENTE>");
  show("PRODUTO EXISTENTE — input do productUpdate", update);

  console.log("\n=== TAGS");
  console.log(`  criação:    ${JSON.stringify(create.tags)}`);
  console.log(`  atualização:${JSON.stringify(update.tags)}`);
  console.log(`  lista permitida: ${JSON.stringify(ALLOWED_PRODUCT_TAGS)}`);
  const sameTags = JSON.stringify(create.tags) === JSON.stringify(update.tags);
  const outside = [...new Set([...create.tags, ...update.tags])].filter((t) => !ALLOWED_PRODUCT_TAGS.includes(t));
  console.log(outside.length ? `\n⚠ o payload traz tags FORA da lista: ${JSON.stringify(outside)} — o escritor é a app.` : `\n✓ o payload só traz tags da lista${sameTags ? "" : " (mas os dois caminhos diferem)"}: se a loja tem outras, vieram de fora da app.`);
}

main()
  .catch((err) => {
    console.error("Erro:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect?.());
