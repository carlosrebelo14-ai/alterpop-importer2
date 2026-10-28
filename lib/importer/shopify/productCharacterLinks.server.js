/**
 * productCharacterLinks — I/O da tabela ProductCharacter (PR 4, decisão de 27/10/2026).
 * A decisão fica em lib/importer/catalog/productCharacterLinks.js (puro). Aqui só se lê
 * e escreve o Prisma. Nunca escreve na Shopify.
 */
import { prisma } from "../../prisma/prismaSafe.server.js";
import { fetchActiveProducts, fetchExistingCharacters } from "./characterPagesSync.server.js";
import { ORIGEM_RESOLVER } from "../catalog/productCharacterLinks.js";

/** Produtos com o que o resolver precisa, para os SKUs dados. */
export async function loadLinkInputs(shop, skus) {
  if (!skus.length) return [];
  return prisma.catalogProduct.findMany({
    where: { shop, sku: { in: skus } },
    select: { sku: true, originalTitle: true, titleOverride: true, resolvedFranchise: true },
  });
}

/** sku -> [{ characterHandle, origem }] já gravado em ProductCharacter. */
export async function loadExistingLinks(shop, skus) {
  const map = new Map();
  if (!skus.length) return map;
  const rows = await prisma.productCharacter.findMany({
    where: { shop, sku: { in: skus } },
    select: { sku: true, characterHandle: true, origem: true },
  });
  for (const r of rows) {
    if (!map.has(r.sku)) map.set(r.sku, []);
    map.get(r.sku).push({ characterHandle: r.characterHandle, origem: r.origem });
  }
  return map;
}

/**
 * SKUs ACTIVE na Shopify, com o valor de alterpop.character já convertido para handles
 * (GID de metaobject -> handle). Só lê.
 * @returns {Promise<{ activeSkus: string[], storeHandlesBySku: Map<string, string[]> }>}
 */
export async function loadActiveAndStoreHandles(client) {
  const activeProducts = await fetchActiveProducts(client);
  const existing = await fetchExistingCharacters(client);
  const handleByGid = new Map([...existing.entries()].map(([handle, v]) => [v.id, handle]));

  const storeHandlesBySku = new Map();
  for (const p of activeProducts) {
    const handles = (p.currentCharacterGids || []).map((gid) => handleByGid.get(gid)).filter(Boolean);
    storeHandlesBySku.set(p.sku, handles);
  }
  return { activeSkus: activeProducts.map((p) => p.sku), storeHandlesBySku };
}

/**
 * Aplica o plano de ligações. Acrescenta sempre; remove só origem "resolver".
 * @param {string} shop
 * @param {ReturnType<import('../catalog/productCharacterLinks.js').planProductCharacterLinks>} plan
 * @returns {Promise<{ added: number, removed: number }>}
 */
export async function applyLinkPlan(shop, plan) {
  let added = 0;
  let removed = 0;
  for (const p of plan) {
    for (const a of p.add) {
      await prisma.productCharacter.upsert({
        where: { shop_sku_characterHandle: { shop, sku: p.sku, characterHandle: a.characterHandle } },
        create: { shop, sku: p.sku, characterHandle: a.characterHandle, origem: a.origem, universeHandle: a.universeHandle ?? null },
        update: { origem: a.origem, universeHandle: a.universeHandle ?? null },
      });
      added += 1;
    }
    if (p.remove.length) {
      const res = await prisma.productCharacter.deleteMany({
        where: { shop, sku: p.sku, origem: ORIGEM_RESOLVER, characterHandle: { in: p.remove } },
      });
      removed += res.count;
    }
  }
  return { added, removed };
}

/** Upsert de linhas com origem "store" (B1). Nunca apaga. */
export async function upsertStoreRows(shop, rows) {
  let written = 0;
  for (const r of rows) {
    await prisma.productCharacter.upsert({
      where: { shop_sku_characterHandle: { shop, sku: r.sku, characterHandle: r.characterHandle } },
      create: { shop, sku: r.sku, characterHandle: r.characterHandle, universeHandle: r.universeHandle, origem: r.origem },
      update: { universeHandle: r.universeHandle, origem: r.origem },
    });
    written += 1;
  }
  return written;
}
