#!/usr/bin/env node
/**
 * Verificação de manutenção do tema publicado (Decisão 32) — a lógica vive agora no serviço
 * da app (lib/importer/shopify/themeContract.server.js), a mesma que a guarda do lote usa.
 *
 * READ-ONLY. Não publica tema, não cria/edita ficheiros: só queries ao Admin GraphQL.
 * Mostra os temas, o tema MAIN, o contrato (bloqueios e avisos) e o templateSuffix das
 * coleções de referência.
 *
 * Correr na Fly:  node scripts/catalog/theme-template-audit.js [--shop <loja>] [--refresh]
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { getThemeContractStatus, refreshThemeContract } from "../../lib/importer/shopify/themeContract.server.js";
import { contractFilenames } from "../../lib/importer/shopify/themeContract.js";

const args = process.argv.slice(2);
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const REFRESH = args.includes("--refresh");

const THEMES = `query TA_Themes { themes(first: 25) { nodes { id name role updatedAt } } }`;
const COLL = `query TA_Coll($h: String!) { collectionByHandle(handle: $h) { handle templateSuffix } }`;

async function main() {
  const client = createShopifyClientFromSession(await loadOfflineSessionForShop(SHOP));
  console.log(`=== theme-template-audit (${SHOP}) ===\n`);

  const themes = (await client.graphql(THEMES)).themes?.nodes || [];
  console.log(`── temas na loja (${themes.length}) ──`);
  for (const t of themes) {
    console.log(`  ${String(t.role).padEnd(12)} ${t.name.padEnd(32)} ${t.id}   (updated ${t.updatedAt?.slice(0, 10)})`);
  }

  const status = await (REFRESH ? refreshThemeContract : getThemeContractStatus)(client, SHOP, { includeFranchise: true });
  console.log(`\n── contrato do tema: ${String(status.status).toUpperCase()}${status.themeName ? ` ("${status.themeName}")` : ""}${status.rebuilt ? " [snapshot reconstruído]" : ""} ──`);
  console.log(`  ficheiros verificados: ${contractFilenames().join(", ")}`);
  for (const b of status.blocking) console.log(`  ✗ BLOQUEIA  ${b.message}`);
  for (const w of status.warnings) console.log(`  ! AVISO     ${w.message}`);
  if (!status.blocking.length && !status.warnings.length) console.log("  ✓ sem bloqueios nem avisos");

  console.log(`\n── coleções reais vs templateSuffix ──`);
  for (const h of ["star-wars", "the-mandalorian"]) {
    const c = (await client.graphql(COLL, { h })).collectionByHandle;
    console.log(`  ${h.padEnd(16)} templateSuffix = ${c?.templateSuffix ? `"${c.templateSuffix}"` : "∅ (default)"}`);
  }

  console.log(`\n(read-only — nenhum tema publicado, nenhum ficheiro tocado.)`);
  if (status.blocking.length) process.exit(2);
}

main().catch((err) => { console.error(err?.stack || err?.message || err); process.exit(1); });
