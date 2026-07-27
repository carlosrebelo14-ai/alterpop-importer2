import { humanizeFranchiseRef } from "../connectors/ociostock/parseFamilies.js";

export function createFacetAccumulator() {
  return {
    categoryMain: new Map(),
    categorySegments: new Map(),
    brands: new Map(),
    franchises: new Map(),
    rowCount: 0,
  };
}

/**
 * @param {ReturnType<typeof createFacetAccumulator>} acc
 * @param {import('../types.js').ProductRecord} r
 */
export function accumulateFacetRow(acc, r) {
  acc.rowCount += 1;
  if (r.categoryMain) increment(acc.categoryMain, r.categoryMain);
  for (const seg of r.categorySegments || []) {
    if (seg) increment(acc.categorySegments, seg);
  }
  if (r.vendor) increment(acc.brands, r.vendor);
  for (const f of r.franchises || []) {
    if (f) increment(acc.franchises, f);
  }
}

/**
 * @param {ReturnType<typeof createFacetAccumulator>} acc
 */
export function finalizeFacetAccumulator(acc) {
  return {
    categoryMain: sortedKeys(acc.categoryMain),
    categorySegments: sortedKeys(acc.categorySegments),
    brands: sortedKeys(acc.brands),
    franchises: sortedKeys(acc.franchises),
    counts: {
      ...mapToCountObj(acc.categoryMain, "categoryMain"),
      ...mapToCountObj(acc.categorySegments, "categorySegments"),
      ...mapToCountObj(acc.brands, "brands"),
      ...mapToCountObj(acc.franchises, "franchises"),
    },
    labels: {
      franchises: Object.fromEntries(
        sortedKeys(acc.franchises).map((ref) => [ref, humanizeFranchiseRef(ref)])
      ),
    },
  };
}

/**
 * @param {import('../types.js').ProductRecord[]} records
 */
export function buildCatalogFacets(records) {
  const acc = createFacetAccumulator();
  for (const r of records) accumulateFacetRow(acc, r);
  return finalizeFacetAccumulator(acc);
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedKeys(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function mapToCountObj(map, prefix) {
  const o = {};
  for (const [k, v] of map) o[`${prefix}:${k}`] = v;
  return o;
}
