#!/usr/bin/env node
/**
 * Garante a definição de metafield `alterpop.hero_image` (Collection) na loja jyr17t-wr.
 *
 * Resposta ao briefing "Universe Room, imagem de capa" (17/09/2026), secção 3 —
 * trabalho do backend: criar a definição, sem escrever nenhum valor em nenhuma
 * coleção. Mesmo padrão de reporte que ensure-character-metaobject.js (adenda backend
 * 17/09): dry-run por omissão, --execute para escrever.
 *
 * Uso:
 *   node scripts/setup/ensure-hero-image-metafield.js            # dry-run: só sonda e reporta
 *   node scripts/setup/ensure-hero-image-metafield.js --execute  # cria se ainda não existir
 *
 * Corre com a sessão OAuth da própria app alterpop-importer (FileSessionStorage em
 * produção — precisa de correr onde essa sessão vive, ver loadOfflineSessionForShop).
 */
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import {
  ALTERPOP_HERO_IMAGE_DEFINITION,
  ensureHeroImageMetafieldDefinition,
} from "../../lib/importer/shopify/heroImageMetafieldDefinition.js";

const EXECUTE = process.argv.includes("--execute");

const FIND = `
  query HeroImageDefFind {
    metafieldDefinitions(first: 1, ownerType: COLLECTION, namespace: "alterpop", key: "hero_image") {
      nodes {
        id
        name
        namespace
        key
        type { name }
        pinnedPosition
        access { admin storefront }
        validations { name value }
      }
    }
  }
`;

async function main() {
  const shop =
    process.env.HERO_IMAGE_SETUP_SHOP ||
    process.env.SHOPIFY_SHOP_URL ||
    "jyr17t-wr.myshopify.com";

  const session = await loadOfflineSessionForShop(shop);
  const client = createShopifyClientFromSession(session);

  console.log("=== Alterpop — ensure alterpop.hero_image (Collection) ===");
  console.log(`Loja: ${session.shop}`);
  console.log(`Modo: ${EXECUTE ? "EXECUTE (vai escrever)" : "dry-run (só sonda)"}`);

  const existing = (await client.graphql(FIND)).metafieldDefinitions?.nodes?.[0];
  if (existing?.id) {
    console.log(`\n= Já existe: ${existing.id}`);
    console.log(
      `  type: ${existing.type?.name} · admin: ${existing.access?.admin} · storefront: ${existing.access?.storefront} · pinned: ${existing.pinnedPosition !== null} · validations: ${JSON.stringify(existing.validations)}`
    );
    console.log(`\n→ ALTERPOP_HERO_IMAGE_DEFINITION_GID = "${existing.id}"`);
    return;
  }

  if (!EXECUTE) {
    console.log("\nNão existe ainda. Dry-run terminado — corre com --execute para criar:");
    console.log(JSON.stringify(ALTERPOP_HERO_IMAGE_DEFINITION, null, 2));
    return;
  }

  const result = await ensureHeroImageMetafieldDefinition(client);
  console.log(`\n✓ Criada via API: ${result.definition.id}`);
  console.log(`  type: ${result.definition.type?.name}`);
  console.log(`\n→ ALTERPOP_HERO_IMAGE_DEFINITION_GID = "${result.definition.id}"`);
  console.log("  Cola este GID em ALTERPOP_HERO_IMAGE_DEFINITION_GID (heroImageMetafieldDefinition.js).");
  console.log(
    "  A mutation de criação não devolve access/pin — corre o script outra vez sem --execute para confirmar admin/storefront/pinned por query."
  );
}

main().catch((err) => {
  console.error("\n✗ " + (err.message || err));
  process.exit(1);
});
