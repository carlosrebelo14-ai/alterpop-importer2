#!/usr/bin/env node
/**
 * Esvaziar a loja Shopify — apagar TODOS os produtos (limpeza 2026-09-09, aprovada
 * pelo Carlos: "5575 produtos publicados são placeholder, a loja não está aberta ao
 * público, não há histórico a preservar").
 *
 * Reutiliza o mecanismo do reset de emergência (lib/importer/shopify/shopifyReset.server.js,
 * o mesmo que o botão "APAGAR" no Admin dispara):
 *   - lista todos os produtos da loja (paginação GraphQL, scope "all")
 *   - `productDelete` em lotes de 20, 1s entre lotes
 *   - reverte a fila local de curadoria: PUBLISHED / SYNC_ERROR → APPROVED, limpa
 *     shopifyProductId → os produtos voltam ao pool aprovado para republicação limpa
 *     pelo pipeline novo (Fase 6b escreve alterpop.franchise no publish)
 *   - desativa os sync errors antigos
 *
 * NÃO toca em coleções (já limpas), na definição alterpop.franchise, nem no catálogo
 * local indexado (CatalogProduct) — só nos produtos Shopify e no estado da fila.
 *
 * DRY-RUN por defeito (só conta). `--execute` apaga.
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/shopify-products-purge.js            # dry-run (conta)
 *   node scripts/catalog/shopify-products-purge.js --execute
 */
import {
  countShopifyProductsForReset,
  runShopifyCatalogReset,
} from "../../lib/importer/shopify/shopifyReset.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  process.env.SPOT_CHECK_SHOP ||
  "jyr17t-wr.myshopify.com";

async function main() {
  const session = { shop: SHOP };

  const count = await countShopifyProductsForReset(session);
  console.log(`=== shopify-products-purge (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===`);
  console.log(`produtos na loja: ${count}`);

  if (!EXECUTE) {
    console.log(`\nDRY-RUN — nada apagado. Corre com --execute.`);
    return;
  }

  if (count === 0) {
    console.log(`\nLoja já vazia — nada a fazer.`);
    return;
  }

  console.log(`\n=== a apagar ${count} produto(s) ===`);
  const t0 = Date.now();
  const res = await runShopifyCatalogReset(session, { skipInit: false });
  const mins = ((Date.now() - t0) / 60000).toFixed(1);

  console.log(
    `\nconcluído em ${mins} min · total ${res.total} · apagados ${res.deleted} · ` +
      `falhas ${res.failed} · revertidos na fila local ${res.revertedLocal}`
  );

  const after = await countShopifyProductsForReset(session);
  console.log(`produtos na loja agora: ${after}`);
  if (after > 0) {
    console.log(`⚠️  ainda restam ${after} — reexecuta --execute (paginação/rate limit).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
