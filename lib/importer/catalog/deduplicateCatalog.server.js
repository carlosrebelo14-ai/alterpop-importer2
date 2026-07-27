import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { loadCurationQueue } from "../../curation/curationQueue.server.js";

/**
 * @param {string} value
 */
export function normalizeCatalogKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");
}

/**
 * @param {{ sku: string, barcode?: string|null, stock?: number, indexedAt?: Date|string|null, title?: string }} row
 * @param {Record<string, string>} shopifyProductIdBySku
 */
function scoreKeeperCandidate(row, shopifyProductIdBySku) {
  let score = 0;
  if (shopifyProductIdBySku[row.sku]) score += 100_000;
  score += Math.max(0, Number(row.stock) || 0) * 10;
  if (row.barcode && normalizeCatalogKey(row.barcode) === normalizeCatalogKey(row.sku)) {
    score += 50;
  }
  const ts = row.indexedAt ? new Date(row.indexedAt).getTime() : 0;
  if (Number.isFinite(ts)) score += ts / 1_000_000_000;
  return score;
}

/**
 * Union-find O(n) — agrupa por SKU normalizado ou EAN igual.
 * @param {Array<{ sku: string, barcode?: string|null, stock?: number, indexedAt?: Date|null, title?: string }>} products
 */
function buildDuplicateGroups(products) {
  /** @type {Map<string, string>} */
  const parent = new Map();

  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  }

  function unionList(skus) {
    if (skus.length < 2) return;
    const root = skus[0];
    find(root);
    for (let i = 1; i < skus.length; i++) {
      const a = find(root);
      const b = find(skus[i]);
      if (a !== b) parent.set(b, a);
    }
  }

  /** @type {Map<string, { sku: string, barcode?: string|null, stock?: number, indexedAt?: Date|null, title?: string }>} */
  const bySku = new Map(products.map((p) => [p.sku, p]));

  /** @type {Map<string, string[]>} */
  const byNormSku = new Map();
  /** @type {Map<string, string[]>} */
  const byNormBarcode = new Map();

  for (const p of products) {
    find(p.sku);
    const skuKey = normalizeCatalogKey(p.sku);
    if (skuKey) {
      if (!byNormSku.has(skuKey)) byNormSku.set(skuKey, []);
      byNormSku.get(skuKey).push(p.sku);
    }
    const bcKey = normalizeCatalogKey(p.barcode);
    if (bcKey.length >= 4) {
      if (!byNormBarcode.has(bcKey)) byNormBarcode.set(bcKey, []);
      byNormBarcode.get(bcKey).push(p.sku);
    }
  }

  for (const skus of byNormSku.values()) unionList(skus);
  for (const skus of byNormBarcode.values()) unionList(skus);

  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const p of products) {
    const root = find(p.sku);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p.sku);
  }

  return [...groups.values()]
    .filter((skus) => skus.length > 1)
    .map((skus) => skus.map((sku) => bySku.get(sku)).filter(Boolean));
}

/**
 * Remove duplicados do catálogo local (SQLite) por SKU normalizado ou código de barras.
 * Mantém o registo com shopify_product_id, maior stock, ou mais recente (indexedAt).
 *
 * @param {string} shop
 */
export async function deduplicateCatalog(shop) {
  const products = await safePrisma("dedup.catalogProduct.findMany", () =>
    prisma.catalogProduct.findMany({
      where: { shop },
      select: {
        sku: true,
        barcode: true,
        stock: true,
        indexedAt: true,
        title: true,
      },
    })
  );

  if (!products.length) {
    return {
      shop,
      groupsFound: 0,
      removed: 0,
      kept: 0,
      removedSkus: [],
    };
  }

  const queue = await loadCurationQueue();
  /** @type {Record<string, string>} */
  const shopifyProductIdBySku = {};
  for (const item of queue.items) {
    const pid = item.metadata?.shopifyProductId;
    if (pid) shopifyProductIdBySku[item.sku] = String(pid);
  }

  const duplicateGroups = buildDuplicateGroups(products);
  /** @type {string[]} */
  const removedSkus = [];
  let kept = 0;

  for (const group of duplicateGroups) {
    const sorted = [...group].sort(
      (a, b) =>
        scoreKeeperCandidate(b, shopifyProductIdBySku) -
        scoreKeeperCandidate(a, shopifyProductIdBySku)
    );
    const [keeper, ...losers] = sorted;
    kept += 1;
    for (const loser of losers) {
      removedSkus.push(loser.sku);
    }
    if (losers.length) {
      console.log(
        `[dedup] Grupo (${group.length}): mantém ${keeper.sku}, remove ${losers.map((l) => l.sku).join(", ")}`
      );
    }
  }

  if (removedSkus.length) {
    await safePrisma("dedup.delete", () =>
      prisma.$transaction([
        prisma.catalogProductFilterTag.deleteMany({
          where: { shop, sku: { in: removedSkus } },
        }),
        prisma.productSalesSnapshot.deleteMany({
          where: { shop, sku: { in: removedSkus } },
        }),
        prisma.catalogProduct.deleteMany({
          where: { shop, sku: { in: removedSkus } },
        }),
      ])
    );
  }

  const summary = {
    shop,
    groupsFound: duplicateGroups.length,
    removed: removedSkus.length,
    kept,
    removedSkus: removedSkus.slice(0, 100),
  };

  console.log(
    `[dedup] Concluído: ${summary.groupsFound} grupo(s), ${summary.removed} SKU(s) removido(s).`
  );

  return summary;
}
