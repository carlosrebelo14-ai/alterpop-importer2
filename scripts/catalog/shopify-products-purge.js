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
 *   - reverte a fila local de curadoria: PUBLISHED → PENDING, limpa shopifyProductId. Os itens ficam
 *     em PENDING, marcados como apagados no admin: nada volta a APPROVED sem aprovação humana (regra de 09/10).
 *     SYNC_ERROR fica como está (Decisão 35, D44).
 *   - desativa os sync errors antigos
 *   - verificação final: zero produtos na loja e zero PUBLISHED na fila
 *
 * NÃO toca em coleções (já limpas), na definição alterpop.franchise, nem no catálogo
 * local indexado (CatalogProduct) — só nos produtos Shopify e no estado da fila.
 *
 * DRY-RUN por defeito: conta os produtos na loja e os itens da fila que passariam a PENDING, sem escrever.
 * `--execute` apaga. Reserva a publicação dentro do motor, e recusa-se com atividade da app ou modo degradado.
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/shopify-products-purge.js            # dry-run (conta)
 *   node scripts/catalog/shopify-products-purge.js --execute
 */
import {
  countShopifyProductsForReset,
  runShopifyCatalogReset,
} from "../../lib/importer/shopify/shopifyReset.server.js";

import { recusarSeAtividadeApp } from "../../lib/curation/atividadeApp.js";
import { readDbDegraded } from "../../lib/health/dbDegraded.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  process.env.SPOT_CHECK_SHOP ||
  "jyr17t-wr.myshopify.com";

async function main() {
  recusarSeAtividadeApp("shopify-products-purge");
  const session = { shop: SHOP };

  console.log(`=== shopify-products-purge (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===`);

  if (!EXECUTE) {
    const plano = await runShopifyCatalogReset(session, { dryRun: true });
    console.log(`produtos na loja: ${plano.produtosNaLoja}`);
    console.log(`itens da fila que passariam a PENDING: ${plano.entradasParaPending}`);
    console.log(`SYNC_ERROR preservado (não se mexe): ${plano.sincroErroPreservado}`);
    // Decisão 42: estado final da fila depois do reset. Nenhum item volta a APPROVED pelo reset.
    console.log(`estado final da fila depois do reset (Decisão 42):`);
    for (const [estado, n] of Object.entries(plano.estadoFinal).sort()) {
      console.log(`  ${estado}: ${n}`);
    }
    console.log(`\nDRY-RUN — nada apagado nem gravado. Corre com --execute.`);
    return;
  }

  // A fila é uma só, da loja configurada. Apagar e reverter numa loja diferente (--shop errado, loja vazia) punha PENDING
  // os PUBLISHED da loja real. Recusa-se antes de tocar em nada. A loja configurada resolve-se como na app
  // (loadOfflineSessionForShop).
  const lojaConfigurada = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP;
  if (SHOP !== lojaConfigurada) {
    console.error(
      `Recusado: --execute só corre na loja configurada (${lojaConfigurada ?? "não definida"}), e o alvo é ${SHOP}. Nada foi apagado.`
    );
    process.exit(3);
  }

  // Modo degradado (Decisão 34): o motor também o verifica antes de cada apagamento. Aqui recusa-se logo.
  const degradado = readDbDegraded();
  if (degradado) {
    console.error(`Recusado: BD em modo degradado (${degradado.cause ?? "causa desconhecida"}). Nada foi apagado.`);
    process.exit(1);
  }

  const count = await countShopifyProductsForReset(session);
  console.log(`produtos na loja: ${count}`);
  // Loja vazia não sai já: o motor confirma o zero (D37), põe em PENDING os PUBLISHED sem produto e verifica o fim.
  if (count === 0) {
    console.log(`\nLoja já vazia — o motor reconcilia a fila e verifica o fim.`);
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
