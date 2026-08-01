import axios from "axios";
import fs from "fs";
import readline from "readline";
import { getDefaultConfig } from "../../config.js";

const USER_AGENT = "AlterpopImporter/1.0";
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * @returns {Promise<import('stream').Readable>}
 */
async function openCsvReadableStream() {
  const { ociostock } = getDefaultConfig();
  if (ociostock.localPath) {
    return fs.createReadStream(ociostock.localPath, { encoding: "utf8" });
  }

  if (!ociostock.csvUrl) {
    throw new Error("OCIOSTOCK_CSV_URL or OCIOSTOCK_CSV_PATH required");
  }

  const response = await axios.get(ociostock.csvUrl, {
    responseType: "stream",
    timeout: DOWNLOAD_TIMEOUT_MS,
    headers: { "User-Agent": USER_AGENT },
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  return response.data;
}

function cleanCell(value) {
  let s = String(value ?? "").trim();
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  // V8 substring/ConsString memory leak fix
  return (' ' + s).slice(1);
}

/**
 * Parse uma linha CSV com separador ; e campos entre aspas.
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
export function parseSemicolonCsvLine(line, delimiter = ";") {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      cells.push(cleanCell(current));
      current = "";
      continue;
    }
    current += ch;
  }

  cells.push(cleanCell(current));
  return cells;
}

/**
 * @param {string[]} values
 * @param {string[]} headers
 */
function mapValuesToRow(values, headers) {
  const mapped = {};
  for (let i = 0; i < headers.length; i++) {
    mapped[headers[i]] = values[i] ?? "";
  }
  return mapped;
}

/**
 * Stream OcioStock CSV linha-a-linha (createReadStream + readline).
 * Nunca carrega o ficheiro inteiro para RAM.
 *
 * @param {object} options
 * @param {(row: Record<string, string>, rowIndex: number) => Promise<void>} options.onRow
 * @param {() => boolean} [options.shouldStop]
 * @param {number} [options.skipRows] — linhas de dados já processadas (após cabeçalho)
 * @returns {Promise<{ rowsRead: number, stoppedEarly: boolean, skipped: number }>}
 */
export async function streamOcioStockRows({ onRow, shouldStop, skipRows = 0 }) {
  const source = await openCsvReadableStream();
  const rl = readline.createInterface({ input: source, crlfDelay: Infinity });

  let rowsRead = 0;
  let skipped = 0;
  let stoppedEarly = false;
  /** @type {string[]|null} */
  let headers = null;
  let yieldCounter = 0;

  try {
    for await (const line of rl) {
      if (!line?.trim()) continue;

      if (!headers) {
        headers = parseSemicolonCsvLine(line);
        continue;
      }

      if (shouldStop?.()) {
        stoppedEarly = true;
        break;
      }

      if (skipped < skipRows) {
        skipped += 1;
        continue;
      }

      const values = parseSemicolonCsvLine(line);
      const mapped = mapValuesToRow(values, headers);
      await onRow(mapped, rowsRead);
      rowsRead += 1;

      // Yield to event loop every 100 rows so HTTP requests can be served.
      yieldCounter += 1;
      if (yieldCounter >= 100) {
        yieldCounter = 0;
        await new Promise((r) => setImmediate(r));
      }

      if (shouldStop?.()) {
        stoppedEarly = true;
        break;
      }
    }
  } finally {
    rl.close();
    if (typeof source.destroy === "function") source.destroy();
  }

  return { rowsRead, stoppedEarly, skipped };
}
