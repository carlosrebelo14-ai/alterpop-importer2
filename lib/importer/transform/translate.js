import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { config } from "../config.js";
import { TRANSLATABLE_FIELDS } from "../connectors/ociostock/csvFieldMap.js";
import { translateCategory } from "./glossary/index.js";
import { translateTitleFromGlossary } from "./glossary/translateTitle.js";

let memoryCache = null;

async function loadCache() {
  if (memoryCache) return memoryCache;
  try {
    const raw = await fs.readFile(config.paths.translationCache, "utf8");
    memoryCache = JSON.parse(raw);
  } catch {
    memoryCache = {};
  }
  return memoryCache;
}

async function saveCache() {
  await fs.mkdir(config.paths.cache, { recursive: true });
  await fs.writeFile(config.paths.translationCache, JSON.stringify(memoryCache, null, 2));
}

function cacheKey(text, field) {
  return crypto.createHash("sha256").update(`${field}:${text}`).digest("hex");
}

function shouldTranslate(text) {
  if (!text || !text.trim()) return false;
  if (/^\d+$/.test(text.trim())) return false;
  return true;
}

export async function translateTextCached(text, field) {
  const cache = await loadCache();
  const key = cacheKey(text, field);
  if (cache[key]) return cache[key];

  let translated;
  const { provider, apiKey, sourceLang, targetLang, libreTranslateUrl } = config.translation;

  switch (provider) {
    case "deepl":
      translated = await translateDeepL(text, sourceLang, targetLang, apiKey);
      break;
    case "libretranslate":
      translated = await translateLibre(text, sourceLang, targetLang, libreTranslateUrl, apiKey);
      break;
    case "passthrough":
    default:
      translated = text;
      break;
  }

  cache[key] = translated;
  memoryCache = cache;
  return translated;
}

async function translateDeepL(text, sourceLang, targetLang, apiKey) {
  if (!apiKey) throw new Error("TRANSLATION_API_KEY required for DeepL");
  const base =
    apiKey.endsWith(":fx") || process.env.DEEPL_FREE === "true"
      ? "https://api-free.deepl.com"
      : "https://api.deepl.com";
  const res = await fetch(`${base}/v2/translate`, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: [text],
      source_lang: sourceLang.toUpperCase(),
      target_lang: targetLang.toUpperCase(),
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`DeepL error: ${JSON.stringify(body)}`);
  return body.translations[0].text;
}

async function translateLibre(text, sourceLang, targetLang, baseUrl, apiKey) {
  const res = await fetch(`${baseUrl}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: text,
      source: sourceLang.toLowerCase(),
      target: targetLang.toLowerCase(),
      format: "text",
      ...(apiKey ? { api_key: apiKey } : {}),
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`LibreTranslate error: ${JSON.stringify(body)}`);
  return body.translatedText;
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @returns {Promise<import('../types.js').ProductRecord>}
 */
async function translateField(original, field, job) {
  if (!shouldTranslate(original)) return original || "";

  if (field === "category" || field === "categoryMain") {
    return translateCategory(original, { job });
  }

  if (field === "title") {
    const { sourceLang = "es" } = config.translation || {};
    return translateTitleFromGlossary(original, sourceLang);
  }

  const { provider } = config.translation;
  if (provider === "passthrough") return original;

  return translateTextCached(original, field);
}

export async function translateProductRecord(record, job) {
  record._translated = {};
  for (const field of TRANSLATABLE_FIELDS) {
    const original = record[field];
    const translated = await translateField(original, field, job);
    record._translated[field] = translated;
    record[field] = translated;
  }
  if (record.categoryMain) {
    record.category = record.categoryMain;
  }
  
  // Translate the franchises/tags array using the categories/segments dictionary
  if (Array.isArray(record.franchises)) {
    const translatedFranchises = [];
    for (const franchise of record.franchises) {
      if (!franchise) continue;
      // translateCategory handles the lookup in categories.json / segments.json
      const translated = await translateCategory(franchise, { job });
      translatedFranchises.push(translated || franchise);
    }
    // Remove duplicates that might arise from translation collapsing two tags into one
    record.franchises = [...new Set(translatedFranchises)];
  }

  return record;
}

/**
 * @param {import('../types.js').ProductRecord[]} records
 */
/**
 * @param {import('../types.js').ProductRecord[]} records
 * @param {import('../jobs/ImportJob.js').ImportJob} [job]
 */
export async function translateRecords(records, job) {
  let cacheHits = 0;
  const cache = await loadCache();
  const beforeSize = Object.keys(cache).length;

  for (const record of records) {
    await translateProductRecord(record, job);
  }

  await saveCache();
  const afterSize = Object.keys(memoryCache || {}).length;
  cacheHits = afterSize - beforeSize;

  return { cacheEntries: afterSize, newEntries: cacheHits };
}
