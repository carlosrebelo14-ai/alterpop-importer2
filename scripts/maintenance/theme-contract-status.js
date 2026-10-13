#!/usr/bin/env node
/* eslint-env node */
// Mesmo resultado que GET /api/theme-contract/status (Decisão 32), para correr na Fly sem sessão do Admin.
// Só lê a loja (queries). Escreve, no máximo, o snapshot em data/theme-contract/ do volume da app,
// que é a cache por updatedAt do tema; nunca escreve no tema nem na loja. Não liga nem desliga THEME_GUARD.
//
// Com --summary imprime só estados e contagens (sem nomes de templates nem JSON completo), para logs públicos.
//
// Uso: node scripts/maintenance/theme-contract-status.js [--stored] [--summary]
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { getThemeContractStatus, readStoredThemeStatus } from "../../lib/importer/shopify/themeContract.server.js";
import { isThemeGuardEnforced } from "../../lib/importer/shopify/themeContract.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const stored = process.argv.includes("--stored");
const summary = process.argv.includes("--summary");

function show(payload) {
  if (!summary) return console.log(JSON.stringify(payload, null, 2));
  const c = payload.contract || {};
  console.log(
    JSON.stringify({
      ok: payload.ok,
      enforced: payload.enforced,
      status: c.status ?? null,
      blocking: Array.isArray(c.blocking) ? c.blocking.length : null,
      warnings: Array.isArray(c.warnings) ? c.warnings.length : null,
      checkedAt: c.checkedAt ?? null,
      erro: payload.ok === false,
    })
  );
}

async function main() {
  const enforced = isThemeGuardEnforced();
  if (stored) {
    show({ ok: true, enforced, contract: await readStoredThemeStatus(SHOP) });
    return;
  }
  try {
    const client = createShopifyClientFromSession(await loadOfflineSessionForShop(SHOP));
    const contract = await getThemeContractStatus(client, SHOP, { includeFranchise: true });
    show({ ok: true, enforced, contract });
  } catch (err) {
    show({ ok: false, enforced, error: err?.message || String(err) });
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[theme-contract-status] fatal:", err);
    process.exit(1);
  })
  .finally(() => process.exit(process.exitCode ?? 0));
