import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import {
  computeFilterTagIdsForProduct,
} from "./sitemapFilters.server.js";

/** @param {string} value */
function vendorNorm(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Colunas escritas pelo upsert, na ordem exata do INSERT/params (sem `indexedAt`, que é
 *  sempre `datetime('now')` literal — nunca um parâmetro). Fonte única para a lista de
 *  colunas, o SET do ON CONFLICT e a extração dos valores — um campo que falte aqui falta
 *  nos três ao mesmo tempo, em vez de divergir em silêncio (caso real: B7, ADENDA 3,
 *  17/09/2026 — resolvedCharacters ficava de fora deste INSERT e cada sync normal
 *  reescrevia-o para NULL mesmo depois do backfill, porque a coluna nunca fazia parte da
 *  lista abaixo). `originalTitle` é o único caso especial: só entra no INSERT, nunca no
 *  UPDATE (Tarefa 10 — preservado através de re-indexações seguintes). */
const UPSERT_COLUMNS = [
  "shop",
  "sku",
  "title",
  "categoryMain",
  "categorySegments",
  "vendor",
  "vendorNorm",
  "stock",
  "franchises",
  "franchiseRefs",
  "resolvedFranchise",
  "resolvedFranchiseLayer",
  "resolvedLine",
  "netPrice",
  "grossPrice",
  "imageUrl",
  "barcode",
  "weightKg",
  "titleSource",
  "dimensions",
  "hsCode",
  "originalTitle",
  "cleanTitle",
  "resolvedFormat",
  "resolvedManufacturerLine",
  "resolvedCharacters",
];

/** Colunas do INSERT que nunca entram no SET do ON CONFLICT — hoje só originalTitle. */
const UPSERT_COLUMNS_INSERT_ONLY = new Set(["originalTitle"]);

/** @param {import('./catalogProducts.server.js').ReturnType<typeof import('./catalogProducts.server.js').toLiteProduct>} p */
function upsertParamsForProduct(shop, p) {
  return [
    shop,
    p.sku,
    p.title,
    p.categoryMain || null,
    JSON.stringify(p.categorySegments || []),
    p.vendor || null,
    vendorNorm(p.vendor),
    p.stock ?? 0,
    JSON.stringify(p.franchises || []),
    JSON.stringify(p.franchiseRefs || []),
    p.resolvedFranchise ?? null,
    p.resolvedFranchiseLayer ?? null,
    p.resolvedLine ?? null,
    p.netPrice ?? null,
    p.grossPrice ?? null,
    p.imageUrl || null,
    p.barcode?.trim() || p.sku || null,
    p.weightKg ?? null,
    p.titleSource ?? null,
    p.dimensions ?? null,
    p.hsCode ?? null,
    // originalTitle: só no INSERT inicial (ON CONFLICT não o reescreve — Tarefa 10,
    // "originalTitle preservado" mesmo em re-indexações seguintes).
    p.originalTitle ?? p.title,
    p.cleanTitle ?? null,
    p.resolvedFormat ?? null,
    p.resolvedManufacturerLine ?? null,
    p.resolvedCharacters ?? null,
  ];
}

// (UPSERT_COLUMNS.length) parâmetros por produto * CHUNK produtos < limite de 999 do
// SQLite — recalculado a partir de UPSERT_COLUMNS.length para nunca voltar a divergir
// manualmente quando um campo novo entrar (era o erro deste bug: CHUNK ficou fixo em 41
// quando a lista de colunas já ia em 25).
const CHUNK = Math.floor(999 / UPSERT_COLUMNS.length);

/**
 * Constrói o SQL + params de um upsert em lote — pura, sem I/O, testável sem BD.
 * @param {string} shop
 * @param {import('./catalogProducts.server.js').ReturnType<typeof import('./catalogProducts.server.js').toLiteProduct>[]} slice
 */
export function buildCatalogUpsertStatement(shop, slice) {
  const placeholders = `(${UPSERT_COLUMNS.map(() => "?").join(", ")}, datetime('now'))`;
  const valueClauses = [];
  const params = [];

  for (const p of slice) {
    valueClauses.push(placeholders);
    params.push(...upsertParamsForProduct(shop, p));
  }

  const setClause = UPSERT_COLUMNS.filter((col) => !UPSERT_COLUMNS_INSERT_ONLY.has(col))
    .map((col) => `${col} = excluded.${col}`)
    .concat("indexedAt = excluded.indexedAt")
    .join(",\n        ");

  const sql = `
      INSERT INTO CatalogProduct (${UPSERT_COLUMNS.join(", ")}, indexedAt)
      VALUES ${valueClauses.join(", ")}
      ON CONFLICT(shop, sku) DO UPDATE SET
        ${setClause};
    `;
  return { sql, params };
}

/**
 * @param {string} shop
 * @param {import('./catalogProducts.server.js').ReturnType<typeof import('./catalogProducts.server.js').toLiteProduct>[]} chunk
 * @param {{ accumulatedTags?: { shop: string, sku: string, filterId: string }[] }} [options]
 */
export async function insertCatalogProductBatch(shop, chunk, options = {}) {
  if (!chunk.length) return;
  const { accumulatedTags = null } = options;

  /** @type {Map<string, typeof chunk[0]>} */
  const bySku = new Map();
  for (const p of chunk) {
    if (p?.sku) bySku.set(p.sku, p);
  }
  const unique = [...bySku.values()];
  if (!unique.length) return;

  // Build all SQL statements first, then execute in ONE transaction.
  const statements = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    statements.push(buildCatalogUpsertStatement(shop, unique.slice(i, i + CHUNK)));
  }

  // Execute ALL upserts in a single transaction — one lock/unlock cycle.
  await safePrisma("catalogProduct.upsertBatch", () =>
    prisma.$transaction(
      statements.map(({ sql, params }) => prisma.$executeRawUnsafe(sql, ...params))
    )
  );

  /** @type {{ shop: string, sku: string, filterId: string }[]} */
  const tagRows = accumulatedTags || [];
  for (const p of unique) {
    for (const filterId of computeFilterTagIdsForProduct(p)) {
      tagRows.push({ shop, sku: p.sku, filterId });
    }
  }

  if (!accumulatedTags && tagRows.length) {
    await bulkInsertCatalogFilterTags(tagRows);
  }
}

/**
 * Insere todas as tags de sitemap em blocos de 2000 no final da indexação.
 * @param {{ shop: string, sku: string, filterId: string }[]} tags
 */
export async function bulkInsertCatalogFilterTags(tags = []) {
  if (!tags.length) return;
  const CHUNK = 250;
  for (let i = 0; i < tags.length; i += CHUNK) {
    const slice = tags.slice(i, i + CHUNK);
    await safePrisma("catalogProductFilterTag.createMany", () =>
      prisma.catalogProductFilterTag.createMany({ data: slice }).catch((err) => {
        if (String(err?.message || "").includes("Unique constraint")) return;
        throw err;
      })
    );
  }
}
