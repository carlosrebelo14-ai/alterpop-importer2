import fs from "fs/promises";
import path from "path";

/** @type {Map<string, Promise<void>>} */
const writeLocks = new Map();

async function withWriteLock(key, fn) {
  const prev = writeLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeLocks.set(key, next);
  try {
    await next;
  } finally {
    if (writeLocks.get(key) === next) writeLocks.delete(key);
  }
}

async function readFailedArray(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

/**
 * Append one failure to results/{jobId}/failed.json without stopping the stream.
 * @param {string} resultsDir
 * @param {object} entry
 */
export async function appendFailedEntry(resultsDir, entry) {
  const filePath = path.join(resultsDir, "failed.json");
  const payload = {
    ...entry,
    loggedAt: entry.loggedAt || new Date().toISOString(),
  };

  await withWriteLock(filePath, async () => {
    const existing = await readFailedArray(filePath);
    existing.push(payload);
    await writeJsonAtomic(filePath, existing);
  });
}
