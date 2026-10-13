import fs from "fs/promises";
import path from "path";
import axios from "axios";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { getDefaultConfig, OCIOSTOCK_FEED_URL_MISSING } from "../config.js";

const USER_AGENT = "AlterpopImporter/1.0";

/**
 * Garante CSV OcioStock em disco (evita stream HTTP abortado a meio da indexação).
 * @param {string} [shop]
 * @param {object} [_settings] ignorado: o URL do feed só vem de OCIOSTOCK_FEED_URL
 * @returns {Promise<string>} caminho local do CSV
 */
export async function ensureLocalOcioStockCsv(shop = "default_shop", _settings = {}) {
  const safeShopName = String(shop || "default_shop").replace(/[^\w.-]/g, "_");
  const cachePath = path.join(
    getDefaultConfig().paths.cache,
    `ociostock-${safeShopName}.csv`
  );

  try {
    const stat = await fs.stat(cachePath);
    if (stat.size > 1_000_000) {
      process.env.OCIOSTOCK_CSV_PATH = cachePath;
      return cachePath;
    }
  } catch {
    /* download */
  }

  const csvUrl = getDefaultConfig().ociostock.csvUrl;
  if (!csvUrl) throw new Error(OCIOSTOCK_FEED_URL_MISSING);

  // O URL é um segredo: nunca vai para o log.
  console.log(`[ociostock-csv] Descarregando CSV do fornecedor para ${cachePath}...`);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  const res = await axios.get(csvUrl, {
    responseType: "stream",
    timeout: 600_000,
    headers: { "User-Agent": USER_AGENT },
  });

  const writer = createWriteStream(cachePath);
  await pipeline(res.data, writer);
  console.log(`[ociostock-csv] CSV descarregado com sucesso via stream para ${cachePath}.`);
  // streamOcioStockRows lê de ociostock.localPath (OCIOSTOCK_CSV_PATH) — sem isto,
  // volta a descarregar o CSV inteiro por rede, duplicando o download por ciclo e
  // arriscando um "aborted" se o fornecedor cortar a segunda ligação.
  process.env.OCIOSTOCK_CSV_PATH = cachePath;
  return cachePath;
}
