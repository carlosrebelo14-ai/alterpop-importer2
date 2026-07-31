import fs from "fs/promises";
import path from "path";
import axios from "axios";
import { getDefaultConfig } from "../config.js";

const USER_AGENT = "AlterpopImporter/1.0";

/**
 * Garante CSV OcioStock em disco (evita stream HTTP abortado a meio da indexação).
 * @param {string} shop
 * @param {{ ociostockCsvUrl?: string }} [settings]
 * @returns {Promise<string>} caminho local do CSV
 */
/**
 * Garante CSV OcioStock em disco (evita stream HTTP abortado a meio da indexação).
 * @param {string} [shop]
 * @param {{ ociostockCsvUrl?: string }} [settings]
 * @returns {Promise<string>} caminho local do CSV
 */
export async function ensureLocalOcioStockCsv(shop = "default_shop", settings = {}) {
  const safeShopName = String(shop || "default_shop").replace(/[^\w.-]/g, "_");
  const cachePath = path.join(
    getDefaultConfig().paths.cache,
    `ociostock-${safeShopName}.csv`
  );

  try {
    const stat = await fs.stat(cachePath);
    if (stat.size > 1_000_000) {
      return cachePath;
    }
  } catch {
    /* download */
  }

  const defaultUrl = "https://ociostock.gesio.be/dyndata/exportaciones/csvzip/catalog_1_50_54_2_40836fd3ce5ea622a4d34a8aa6c8cda3_csv_plain.csv";
  const csvUrl = settings.ociostockCsvUrl || process.env.OCIOSTOCK_CSV_URL || defaultUrl;

  console.log(`[ociostock-csv] Descarregando CSV do fornecedor (${csvUrl}) para ${cachePath}...`);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  const res = await axios.get(csvUrl, {
    responseType: "arraybuffer",
    timeout: 600_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { "User-Agent": USER_AGENT },
  });

  await fs.writeFile(cachePath, res.data);
  console.log(`[ociostock-csv] CSV descarregado com sucesso (${res.data.length} bytes).`);
  return cachePath;
}
