/**
 * Plano do scripts/catalog/format-backfill.js — C3 (briefing 29/09/2026). Puro.
 * Testado em scripts/tests/format-backfill-plan.test.js.
 */
import { FORMAT_VOCABULARY } from "./formatExtractor.server.js";

const inVocabulary = (v) => FORMAT_VOCABULARY.includes(v);

/**
 * @param {Array<{ productId: string, handle: string, sku: string|null,
 *                 liveFormat: string|null, computed: string|null, prismaFormat: string|null,
 *                 hasCatalogRow: boolean, syncLocked?: boolean }>} rows
 * @param {{ includeLocked?: boolean }} [opts]
 */
export function planFormatBackfill(rows, opts = {}) {
  const sets = [];
  const alreadyOk = [];
  const staysEmpty = [];
  const liveToClear = [];
  const outsideVocabulary = [];
  const prismaStale = [];
  const noCatalogRow = [];
  const lockedSkipped = [];

  for (const r of rows || []) {
    if (!r.hasCatalogRow) {
      noCatalogRow.push(r);
      continue;
    }
    if (r.computed != null && !inVocabulary(r.computed)) {
      outsideVocabulary.push(r);
      continue;
    }
    // O indexador ainda não correu com o vocabulário novo: escrever agora punha a loja à
    // frente do Prisma e o V13 (drift) via o contrário.
    if ((r.prismaFormat ?? null) !== (r.computed ?? null)) {
      prismaStale.push(r);
      continue;
    }
    if (r.computed == null) {
      // Fica vazio (MISSING_FORMAT). Com valor live antigo ("Figure"), o valor sai com
      // metafieldsDelete — exceção à regra de escrita, só neste script (29/09/2026).
      if (r.liveFormat == null) staysEmpty.push(r);
      else if (r.syncLocked && !opts.includeLocked) lockedSkipped.push(r);
      else liveToClear.push(r);
      continue;
    }
    if (r.liveFormat === r.computed) {
      alreadyOk.push(r);
      continue;
    }
    if (r.syncLocked && !opts.includeLocked) lockedSkipped.push(r);
    else sets.push(r);
  }

  const countBy = (list, key) => {
    const m = new Map();
    for (const r of list) {
      const k = r[key] ?? "(vazio)";
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const all = rows || [];
  const afterRows = all.map((r) => {
    if (sets.includes(r)) return { v: r.computed };
    if (liveToClear.includes(r)) return { v: null };
    return { v: r.liveFormat };
  });

  return {
    sets,
    alreadyOk,
    staysEmpty,
    liveToClear,
    outsideVocabulary,
    prismaStale,
    noCatalogRow,
    lockedSkipped,
    /** Guardas que impedem qualquer escrita. */
    blocked: outsideVocabulary.length > 0 || prismaStale.length > 0,
    before: countBy(all, "liveFormat"),
    after: countBy(afterRows, "v"),
    processed:
      sets.length + alreadyOk.length + staysEmpty.length + liveToClear.length +
      outsideVocabulary.length + prismaStale.length + noCatalogRow.length + lockedSkipped.length,
  };
}

/** Metafield alterpop.format (list.single_line_text_field) para metafieldsSet. */
export function formatMetafieldInput(productId, value) {
  return {
    ownerId: productId,
    namespace: "alterpop",
    key: "format",
    type: "list.single_line_text_field",
    value: JSON.stringify([value]),
  };
}

/** Identificador para metafieldsDelete de alterpop.format (produtos que ficam vazios). */
export function formatMetafieldDeleteInput(productId) {
  return { ownerId: productId, namespace: "alterpop", key: "format" };
}

/**
 * Vazios (MISSING_FORMAT depois do backfill) agrupados por marca — chave do feed.
 * @param {ReturnType<typeof planFormatBackfill>} plan
 * @returns {Array<{ vendor: string, count: number, rows: object[] }>}
 */
export function emptiesByVendor(plan) {
  const m = new Map();
  for (const r of [...plan.liveToClear, ...plan.staysEmpty]) {
    const k = r.vendor || "(sem vendor)";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()]
    .map(([vendor, rows]) => ({ vendor, count: rows.length, rows }))
    .sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
}
