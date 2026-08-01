import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cached = null;
const missingByJob = new Map();
/** @type {Map<string, Promise<void>>} */
const glossaryWriteLocks = new Map();

const DEFAULT_SETTINGS = {
  fallback: "original",
  caseSensitive: false,
};

/**
 * @param {string} text
 * @param {boolean} caseSensitive
 */
function normalizeKey(text, caseSensitive) {
  const trimmed = String(text || "").trim().replace(/\s+/g, " ");
  return caseSensitive ? trimmed : trimmed.toUpperCase();
}

/**
 * @param {string} filename
 * @returns {{ map: Map<string, string>, settings: typeof DEFAULT_SETTINGS }}
 */
function loadGlossaryFile(filename) {
  let raw;
  const buildPath = path.join(process.cwd(), "lib", "importer", "transform", "glossary", filename);
  try {
    raw = fs.readFileSync(buildPath, "utf8");
  } catch {
    const rootPath = path.join(process.cwd(), "lib/importer/transform/glossary", filename);
    raw = fs.readFileSync(rootPath, "utf8");
  }
  const parsed = JSON.parse(raw);

  let entries;
  let settings = { ...DEFAULT_SETTINGS };

  if (parsed.mappings && typeof parsed.mappings === "object") {
    entries = Object.entries(parsed.mappings);
    if (parsed.settings) {
      settings = { ...settings, ...parsed.settings };
    }
  } else {
    entries = Object.entries(parsed);
  }

  const caseSensitive = settings.caseSensitive === true;
  const map = new Map();
  for (const [k, v] of entries) {
    map.set(normalizeKey(k, caseSensitive), v);
  }
  return { map, settings };
}

function getMaps() {
  if (cached) return cached;
  cached = {
    categories: loadGlossaryFile("categories.json"),
    segments: loadGlossaryFile("segments.json"),
  };
  return cached;
}

/**
 * @param {Map<string, string>} map
 * @param {string} text
 * @param {boolean} caseSensitive
 */
function lookupInMap(map, text, caseSensitive) {
  if (!text?.trim()) return null;
  return map.get(normalizeKey(text.trim(), caseSensitive)) ?? null;
}

/**
 * @param {string} text
 * @returns {string|null}
 */
export function lookupCategoryGlossary(text) {
  return lookupGlossary(text);
}

/**
 * @param {string} text
 * @returns {string|null}
 */
function lookupGlossary(text) {
  if (!text?.trim()) return null;

  const { categories, segments } = getMaps();
  const { map: catMap, settings } = categories;
  const { map: segMap } = segments;
  const caseSensitive = settings.caseSensitive === true;
  const raw = text.trim();

  const direct = lookupInMap(catMap, raw, caseSensitive);
  if (direct) return direct;

  if (raw.includes("|")) {
    const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
    const translated = parts.map((part) => {
      return (
        lookupInMap(catMap, part, caseSensitive) ||
        lookupInMap(segMap, part, caseSensitive) ||
        lookupInMap(segMap, part.replace(/\s/g, ""), caseSensitive) ||
        null
      );
    });

    if (translated.every((t) => t != null)) {
      return translated.join(" | ");
    }
    if (translated.some((t) => t != null)) {
      return translated.map((t, i) => t ?? parts[i]).join(" | ");
    }
    return null;
  }

  return (
    lookupInMap(segMap, raw, caseSensitive) ||
    lookupInMap(segMap, raw.replace(/\s/g, ""), caseSensitive) ||
    null
  );
}

/**
 * @param {string} esCategory
 * @param {import('../../jobs/ImportJob.js').ImportJob} [job]
 */
function trackMissing(esCategory, job) {
  if (!job?.jobId || !esCategory?.trim()) return;
  const key = job.jobId;
  if (!missingByJob.has(key)) missingByJob.set(key, new Map());
  const map = missingByJob.get(key);
  const norm = esCategory.trim();
  map.set(norm, (map.get(norm) || 0) + 1);
}

/**
 * Translate category ES → EN using glossary mappings; fallback per settings.
 * @param {string} esCategory Spanish category from CSV
 * @param {{ job?: import('../../jobs/ImportJob.js').ImportJob }} [options]
 * @returns {string}
 */
export function translateCategory(esCategory, options = {}) {
  const original = String(esCategory || "").trim();
  if (!original) return "";

  const match = lookupGlossary(original);
  if (match) return match;

  const { settings } = getMaps().categories;
  trackMissing(original, options.job);

  if (settings.fallback === "original") {
    return original;
  }

  return original;
}

/**
 * Serialize disk writes per job (safe if multiple chunks flush concurrently).
 * @param {string} jobId
 * @param {() => Promise<void>} fn
 */
async function withGlossaryWriteLock(jobId, fn) {
  const previous = glossaryWriteLocks.get(jobId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  glossaryWriteLocks.set(jobId, next);
  try {
    await next;
  } finally {
    if (glossaryWriteLocks.get(jobId) === next) {
      glossaryWriteLocks.delete(jobId);
    }
  }
}

/**
 * Atomic JSON write: temp file in same directory, then rename.
 * @param {string} filePath
 * @param {unknown} data
 */
async function writeJsonAtomic(filePath, data) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(data, null, 2);
  await fsPromises.writeFile(tmpPath, body, "utf8");
  await fsPromises.rename(tmpPath, filePath);
}

/**
 * @param {string} filePath
 * @returns {Promise<{ entries: { category: string, count: number }[] } | null>}
 */
async function readMissingGlossaryFile(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.entries)) return parsed;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code !== "ENOENT") {
      throw err;
    }
  }
  return null;
}

/**
 * @param {Map<string, number>} inMemory
 * @param {{ category: string, count: number }[]} [onDisk]
 */
function mergeMissingEntries(inMemory, onDisk = []) {
  const merged = new Map(onDisk.map((e) => [e.category, e.count]));
  for (const [category, count] of inMemory) {
    merged.set(category, (merged.get(category) || 0) + count);
  }
  return [...merged.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Persist missing glossary entries (merge + atomic write). Safe for concurrent chunk flushes.
 * @param {import('../../jobs/ImportJob.js').ImportJob} job
 * @param {{ clearMemory?: boolean }} [options]
 */
export async function persistMissingGlossaryLog(job, options = {}) {
  const map = missingByJob.get(job.jobId);
  if (!map || map.size === 0) return;

  const file = path.join(job.resultsDir, "missing_glossary.json");

  await withGlossaryWriteLock(job.jobId, async () => {
    const existing = await readMissingGlossaryFile(file);
    const entries = mergeMissingEntries(map, existing?.entries);

    await writeJsonAtomic(file, {
      jobId: job.jobId,
      updatedAt: new Date().toISOString(),
      totalMissing: entries.length,
      entries,
      hint: "Add these keys to lib/importer/transform/glossary/categories.json under mappings",
    });

    if (options.clearMemory !== false) {
      map.clear();
    }
  });
}

/**
 * Final flush at job end (atomic, merges any prior on-disk snapshot).
 * @param {import('../../jobs/ImportJob.js').ImportJob} job
 */
export async function flushMissingGlossaryLog(job) {
  const map = missingByJob.get(job.jobId);
  if (!map || map.size === 0) {
    missingByJob.delete(job.jobId);
    return;
  }

  await persistMissingGlossaryLog(job, { clearMemory: true });
  missingByJob.delete(job.jobId);
}

/** @deprecated use translateCategory */
export function translateCategoryFromGlossary(text) {
  return lookupGlossary(text);
}

/** Expose settings for tests / docs */
export function getGlossarySettings() {
  return getMaps().categories.settings;
}
