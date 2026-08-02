#!/usr/bin/env node
/**
 * Garante a definição do metafield ociostock.net_price na Dev Store (Admin GraphQL).
 *
 * Uso: node scripts/setup-metafields.js
 * Requer sessão OAuth em Prisma (abre a app no Admin com npm run dev).
 */
import prisma from "../../app/db.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  createOciostockNetPriceMetafield,
  OCIOSTOCK_NET_PRICE_DEFINITION,
} from "../../lib/importer/shopify/metafieldSetup.js";

async function loadSession() {
  const shop =
    process.env.SPOT_CHECK_SHOP ||
    process.env.SHOPIFY_DEV_STORE ||
    "alterpop-store.myshopify.com";

  const session = await prisma.session.findFirst({
    where: { shop },
    orderBy: { id: "desc" },
  });

  if (!session?.accessToken) {
    throw new Error(
      `Sem sessão para ${shop}. Corre npm run dev e abre a app no Admin para OAuth.`
    );
  }

  return { shop: session.shop, accessToken: session.accessToken };
}

async function main() {
  const session = await loadSession();
  const client = createShopifyClientFromSession(session);

  console.log("=== Alterpop — setup metafields ===");
  console.log(`Loja: ${session.shop}`);
  console.log(
    `Alvo: ${OCIOSTOCK_NET_PRICE_DEFINITION.namespace}.${OCIOSTOCK_NET_PRICE_DEFINITION.key} (${OCIOSTOCK_NET_PRICE_DEFINITION.type})`
  );

  const result = await createOciostockNetPriceMetafield(client);

  if (result.created) {
    console.log("✓ Definição criada:", result.definition.id);
  } else {
    console.log("✓ Já existia:", result.definition.id, result.definition.type?.name);
  }
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
