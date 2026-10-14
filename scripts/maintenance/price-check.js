#!/usr/bin/env node
/* eslint-env node */
// Só leitura (nenhuma mutation, nenhum ficheiro escrito). Lê na Shopify shop.taxesIncluded e os preços
// dos publicados e compara com a regra NET, como a pré-visualização do painel, com PRICE_MODE tal como está.
// Imprime SÓ contagens, linhas "PC: chave=valor" (sem SKUs, handles nem preços), para logs públicos.
//
// Uso (na Fly): node scripts/maintenance/price-check.js
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { runPriceCheck, formatPriceCheck } from "../../lib/importer/pricing/priceCheck.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

try {
  const client = createShopifyClientFromSession(await loadOfflineSessionForShop(SHOP));
  const result = await runPriceCheck({ shop: SHOP, client });
  for (const line of formatPriceCheck(result)) console.log(line);
  process.exit(0);
} catch (err) {
  console.log("PC: erro=leitura_falhou");
  console.error(`[price-check] ${err?.message || err}`);
  process.exit(1);
}
