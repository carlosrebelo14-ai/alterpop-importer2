// B14 (briefing backend, 24/09/2026), secção 4.
//
// shopify.app.toml declara o PEDIDO de scope, não a CONCESSÃO — só a loja, ao aprovar no
// Admin, concede de facto. Este script só lê: carrega a sessão offline e pergunta à
// própria Shopify (currentAppInstallation.accessScopes) o que está concedido agora.
//
// Uso: node scripts/maintenance/print-access-scopes.js
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { checkAccessScopes, REQUIRED_PUBLISH_SCOPES } from "../../lib/importer/shopify/accessScopesGuard.js";

const SHOP = process.env.SHOPIFY_SHOP_URL;

const ACCESS_SCOPES_QUERY = `
  query PrintAccessScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_URL not set");
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const data = await client.graphql(ACCESS_SCOPES_QUERY);
  const handles = (data.currentAppInstallation?.accessScopes || []).map((s) => s.handle).sort();

  console.log(`[print-access-scopes] ${handles.length} scope(s) concedido(s) em ${SHOP}:`);
  for (const h of handles) console.log(`  - ${h}`);

  const result = checkAccessScopes(handles, REQUIRED_PUBLISH_SCOPES);
  for (const scope of REQUIRED_PUBLISH_SCOPES) {
    const grantedNow = result.granted.includes(scope);
    console.log(`[print-access-scopes] ${scope}: ${grantedNow ? "concedido" : "EM FALTA"}`);
  }

  if (!result.ok) {
    console.error(
      `[print-access-scopes] FATAL: scope(s) em falta: ${result.missing.join(", ")}. Concedidos no Admin: Apps → Alterpop → reautorizar.`
    );
    process.exit(1);
  }

  console.log("[print-access-scopes] OK — read_publications e write_publications concedidos.");
}

main().catch((err) => {
  console.error("[print-access-scopes] fatal:", err);
  process.exit(1);
});
