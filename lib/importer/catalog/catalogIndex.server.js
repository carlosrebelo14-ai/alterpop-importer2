import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { mapOcioStockRow } from "../connectors/ociostock/csvFieldMap.js";
import { streamOcioStockRows } from "../connectors/ociostock/streamCsv.js";
import {
  accumulateFacetRow,
  createFacetAccumulator,
  finalizeFacetAccumulator,
} from "./buildFacets.js";
import { refreshCatalogProductsLite } from "./catalogProducts.server.js";
import { translateFacetLabels } from "../transform/translateFacets.js";

const TTL_MS = 24 * 60 * 60 * 1000;

function indexPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}.json`
  );
}

const EMPTY_CATALOG_INDEX = {
  updatedAt: null,
  totalRows: 0,
  facets: { brands: [] },
  facetsEn: {},
};

/** Só lê o JSON em disco — nunca faz fetch CSV (uso no loader da UI). */
export async function loadCatalogIndexCachedOnly(shop) {
  try {
    const raw = await fs.readFile(indexPath(shop), "utf8");
    return JSON.parse(raw);
  } catch {
    return { ...EMPTY_CATALOG_INDEX };
  }
}

export async function loadCatalogIndex(shop, { refresh = false, settings = {} } = {}) {
  const file = indexPath(shop);
  if (!refresh) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const cached = JSON.parse(raw);
      if (Date.now() - new Date(cached.updatedAt).getTime() < TTL_MS) {
        return cached;
      }
    } catch {
      /* rebuild */
    }
  }
  return refreshCatalogIndex(shop, settings);
}

export async function refreshCatalogIndex(shop, settings = {}) {
  await fs.mkdir(path.dirname(indexPath(shop)), { recursive: true });

  if (settings.ociostockCsvUrl) {
    process.env.OCIOSTOCK_CSV_URL = settings.ociostockCsvUrl;
  }

  const facetAcc = createFacetAccumulator();
  await streamOcioStockRows({
    onRow: async (rawRow) => {
      const record = mapOcioStockRow(rawRow);
      if (record) accumulateFacetRow(facetAcc, record);
    },
  });

  const facets = finalizeFacetAccumulator(facetAcc);
  const facetsEn = await translateFacetLabels(facets, settings);

  const index = {
    updatedAt: new Date().toISOString(),
    totalRows: facetAcc.rowCount,
    facets,
    facetsEn,
  };

  await fs.writeFile(indexPath(shop), JSON.stringify(index, null, 2));
  await refreshCatalogProductsLite(shop, settings);
  return index;
}
