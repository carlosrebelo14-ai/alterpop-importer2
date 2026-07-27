#!/usr/bin/env node
/**
 * Garante definições de metafields OcioStock na Dev Store (cria se não existirem).
 *
 * Uso: node scripts/ensure-metafield-definitions.js
 * Requer sessão OAuth (npm run dev + abrir app no Admin).
 */
import prisma from "../app/db.server.js";
import { createShopifyClientFromSession } from "../lib/importer/shopifyClient.js";
import {
  ensureOciostockMetafieldDefinitions,
  OCIOSTOCK_NET_PRICE_DEFINITION,
} from "../lib/importer/shopify/metafieldSetup.js";

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
      `Sem sessão OAuth para ${shop}. Corre npm run dev e abre a app no Admin.`
    );
  }

  return { shop: session.shop, accessToken: session.accessToken };
}

async function main() {
  const session = await loadSession();
  const client = createShopifyClientFromSession(session);

  console.log("=== Alterpop — ensure metafield definitions ===");
  console.log(`Loja: ${session.shop}`);
  console.log(
    `Alvo: ${OCIOSTOCK_NET_PRICE_DEFINITION.namespace}.${OCIOSTOCK_NET_PRICE_DEFINITION.key}`
  );

  await ensureOciostockMetafieldDefinitions(client);
  console.log("✓ Metafield ociostock.net_price garantido.");
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
