import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";

function statusPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}-rebuild-status.json`
  );
}

export async function readCatalogRebuildStatus(shop) {
  try {
    const raw = await fs.readFile(statusPath(shop), "utf8");
    return JSON.parse(raw);
  } catch {
    return { state: "idle", startedAt: null, finishedAt: null, error: null, totalRows: 0 };
  }
}

export async function writeCatalogRebuildStatus(shop, status) {
  await fs.mkdir(path.dirname(statusPath(shop)), { recursive: true });
  const prev = await readCatalogRebuildStatus(shop);
  await fs.writeFile(
    statusPath(shop),
    JSON.stringify({ ...prev, ...status }, null, 2)
  );
}

/** Indexação interrompida com checkpoint — pode retomar sem apagar SQLite. */
export function canResumeCatalogRebuild(status) {
  const scanned = Number(status?.checkpointScanned ?? status?.scanned ?? 0);
  return (
    scanned > 0 &&
    (status?.state === "failed" || status?.state === "interrupted") &&
    status?.indexing !== true
  );
}
