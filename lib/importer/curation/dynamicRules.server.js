import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";

export const DEFAULT_MARKET_SETTINGS = {
  vipBrands: [
    "banpresto",
    "funko",
    "bandai",
    "hot toys",
    "kotobukiya",
    "noble collection",
    "abystyle",
    "sd toys",
    "pyramid international",
    "paladone",
    "neca",
    "sideshow",
    "lego",
    "mcfarlane",
    "hasbro",
    "mattel",
    "tamashii nations",
    "iron studios",
    "good smile company",
  ],
  vipLicences: [
    "star wars",
    "harry potter",
    "marvel",
    "dc comics",
    "dragon ball",
    "one piece",
    "naruto",
    "nintendo",
    "disney",
    "pokemon",
    "pixar",
  ],
  vipCategories: [
    "action figures",
    "figures & statues",
    "statues",
    "replicas",
    "board games",
    "trading cards",
    "puzzles",
  ],
  blockedTerms: [
    "mugs",
    "tazas",
    "lamps",
    "candeeiros",
    "keyrings",
    "llaveros",
    "papeleria",
    "escolar",
  ],
};

/** @type {Map<string, ReturnType<typeof mergeWithDefaults>>} */
const cacheByShop = new Map();
let activeShop = null;

function normalizeList(values) {
  return [...new Set((values || []).map((v) => String(v).trim()).filter(Boolean))];
}

function mergeWithDefaults(raw = {}) {
  return {
    vipBrands: normalizeList(raw.vipBrands || DEFAULT_MARKET_SETTINGS.vipBrands),
    vipLicences: normalizeList(raw.vipLicences || DEFAULT_MARKET_SETTINGS.vipLicences),
    vipCategories: normalizeList(raw.vipCategories || DEFAULT_MARKET_SETTINGS.vipCategories),
    blockedTerms: normalizeList(raw.blockedTerms || DEFAULT_MARKET_SETTINGS.blockedTerms),
  };
}

function parseJsonList(raw) {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toDbPayload(payload) {
  const normalized = mergeWithDefaults(payload);
  return {
    vipBrands: JSON.stringify(normalized.vipBrands),
    vipLicences: JSON.stringify(normalized.vipLicences),
    vipCategories: JSON.stringify(normalized.vipCategories),
    blockedTerms: JSON.stringify(normalized.blockedTerms),
  };
}

function fromDbRow(row) {
  if (!row) return mergeWithDefaults();
  return mergeWithDefaults({
    vipBrands: parseJsonList(row.vipBrands),
    vipLicences: parseJsonList(row.vipLicences),
    vipCategories: parseJsonList(row.vipCategories),
    blockedTerms: parseJsonList(row.blockedTerms),
  });
}

export function setActiveMarketShop(shop) {
  activeShop = shop || null;
}

export function loadMarketSettings(shop = activeShop || "default") {
  return cacheByShop.get(shop) || mergeWithDefaults();
}

/**
 * Pré-carrega settings da BD para uso síncrono no motor O(n).
 * @param {string} shop
 */
export async function primeMarketSettingsForShop(shop) {
  const row = await safePrisma("marketSettings.findUnique", () =>
    prisma.marketSettings.findUnique({ where: { shop } }),
    { rethrow: false, fallback: null }
  );
  const parsed = fromDbRow(row);
  cacheByShop.set(shop, parsed);
  activeShop = shop;
  return parsed;
}

export async function saveMarketSettings(shop, payload) {
  const dbPayload = toDbPayload(payload);
  const row = await safePrisma("marketSettings.upsert", () =>
    prisma.marketSettings.upsert({
      where: { shop },
      create: { shop, ...dbPayload },
      update: dbPayload,
    })
  );
  const parsed = fromDbRow(row);
  cacheByShop.set(shop, parsed);
  activeShop = shop;
  return parsed;
}

export async function readMarketSettingsJson(shop) {
  const settings = await primeMarketSettingsForShop(shop);
  return JSON.stringify(settings, null, 2);
}

export function clearMarketSettingsCache(shop = null) {
  if (shop) cacheByShop.delete(shop);
  else cacheByShop.clear();
}

