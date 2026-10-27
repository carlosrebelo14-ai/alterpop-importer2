#!/usr/bin/env node
/**
 * PR 4 — verificação read-only de I1 a I6 (lib/importer/catalog/characterInvariants.js).
 * Só lê a loja e o Prisma. Sai com 1 se houver vermelho. Amarelo vai para o relatório.
 *
 * Correr na Fly:  node scripts/verify-character-invariants.js
 *                 node scripts/verify-character-invariants.js --baseline
 *
 * --baseline (PR 4, desvio 4 do arquiteto, 27/10/2026): I1 antes do passo 7 é baseline.
 * `products` a null lê-se como lista vazia, por isso I1 fica vermelho até o passo 7 escrever
 * o array completo. Com --baseline, I1 aparece no relatório e não bloqueia. Os restantes vermelhos bloqueiam.
 */
import { prisma } from "../lib/prisma/prismaSafe.server.js";
import { loadOfflineSessionForShop } from "../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../lib/importer/shopifyClient.js";
import { checkCharacterInvariants } from "../lib/importer/catalog/characterInvariants.js";
import { buildInvariantInput } from "../lib/importer/catalog/characterInvariantInput.js";
import { FRANCHISE_UNIVERSES } from "../lib/importer/catalog/franchiseUniverses.js";
import { MANUFACTURER_TIERS } from "../lib/importer/catalog/manufacturerTiers.js";
import { CHARACTER_METAOBJECT_TYPE } from "../lib/importer/shopify/characterMetaobjectSetup.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const PAGE = 100;
const BASELINE = process.argv.includes("--baseline");

const PUBLISHED_PRODUCTS_QUERY = `
  query VerifyProducts($cursor: String) {
    products(first: ${PAGE}, after: $cursor, query: "status:active published_status:published") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        status
        vendor
        variants(first: 1) { nodes { sku } }
        franchise: metafield(namespace: "alterpop", key: "franchise") { value }
        character: metafield(namespace: "alterpop", key: "character") { value }
      }
    }
  }
`;

const CHARACTERS_QUERY = `
  query VerifyCharacters($cursor: String) {
    metaobjects(type: "${CHARACTER_METAOBJECT_TYPE}", first: ${PAGE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        capabilities { publishable { status } }
        universe: field(key: "universe") { value }
        products: field(key: "products") { value }
      }
    }
  }
`;

const UNIVERSE_COLLECTION_QUERY = `
  query VerifyUniverse($handle: String!) {
    collectionByHandle(handle: $handle) {
      id
      handle
      characters: metafield(namespace: "alterpop", key: "characters") { value }
    }
  }
`;

/** Percorre uma ligação paginada e devolve os nós. */
async function fetchAll(client, query, pick) {
  const nodes = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(query, { cursor });
    const conn = pick(data);
    nodes.push(...(conn?.nodes || []));
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return nodes;
}

async function main() {
  console.log(`\n=== verify-character-invariants (${SHOP}) · read-only ===\n`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const shopProducts = await fetchAll(client, PUBLISHED_PRODUCTS_QUERY, (d) => d?.products);
  const characterNodes = await fetchAll(client, CHARACTERS_QUERY, (d) => d?.metaobjects);

  // Tudo passa por GID antes de comparar (ver lib/importer/catalog/characterInvariantInput.js).
  const universeCollections = [];
  for (const u of FRANCHISE_UNIVERSES) {
    if (!u.handle) continue;
    const data = await client.graphql(UNIVERSE_COLLECTION_QUERY, { handle: u.handle });
    const col = data?.collectionByHandle;
    if (!col) continue;
    universeCollections.push({ name: u.name, id: col.id, characters: col.characters });
  }
  const { products, characters, universeCharacters } = buildInvariantInput({
    characterNodes,
    productNodes: shopProducts.map((n) => ({ ...n, sku: n.variants?.nodes?.[0]?.sku || null })),
    universeCollections,
  });

  const canonicalVendors = new Set(MANUFACTURER_TIERS.map((m) => m.name));
  const { red, yellow } = checkCharacterInvariants({ characters, products, universeCharacters, canonicalVendors });

  console.log(`produtos ACTIVE publicados: ${products.length} · characters: ${characters.size}`);
  const baseline = BASELINE ? red.filter((r) => r.id === "I1") : [];
  const blocking = red.filter((r) => !baseline.includes(r));
  for (const r of red) {
    const tag = baseline.includes(r) ? "BASELINE" : "VERMELHO";
    console.log(`${tag} ${r.id}  ${r.handle || r.sku}  ${r.message}`);
  }
  for (const y of yellow) console.log(`amarelo  ${y.id}  ${y.sku}  ${y.message}`);
  console.log(`\nvermelho bloqueante: ${blocking.length} · baseline I1: ${baseline.length} · amarelo: ${yellow.length}`);

  await prisma.$disconnect();
  process.exitCode = blocking.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
