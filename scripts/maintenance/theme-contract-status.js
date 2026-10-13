#!/usr/bin/env node
/* eslint-env node */
// Mesmo resultado que GET /api/theme-contract/status (Decisão 32), para correr na Fly sem sessão do Admin.
// Só lê a loja (queries). Escreve, no máximo, o snapshot em data/theme-contract/ do volume da app,
// que é a cache por updatedAt do tema; nunca escreve no tema nem na loja. Não liga nem desliga THEME_GUARD.
//
// Uso: node scripts/maintenance/theme-contract-status.js [--stored]
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { getThemeContractStatus, readStoredThemeStatus } from "../../lib/importer/shopify/themeContract.server.js";
import { isThemeGuardEnforced } from "../../lib/importer/shopify/themeContract.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const stored = process.argv.includes("--stored");

async function main() {
  const enforced = isThemeGuardEnforced();
  if (stored) {
    console.log(JSON.stringify({ ok: true, enforced, contract: await readStoredThemeStatus(SHOP) }, null, 2));
    return;
  }
  try {
    const client = createShopifyClientFromSession(await loadOfflineSessionForShop(SHOP));
    const contract = await getThemeContractStatus(client, SHOP, { includeFranchise: true });
    console.log(JSON.stringify({ ok: true, enforced, contract }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, enforced, error: err?.message || String(err) }, null, 2));
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[theme-contract-status] fatal:", err);
    process.exit(1);
  })
  .finally(() => process.exit(process.exitCode ?? 0));
