import fs from "fs";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { normalizeForMatch } from "./loadCuration.js";

let cached = null;

/**
 * @returns {import('./evaluateExcludeList.server.js').ExcludeListConfig}
 */
export function loadExcludeList() {
  if (cached) return cached;

  const filePath = path.join(getDefaultConfig().paths.serverData, "exclude-list.json");
  if (!fs.existsSync(filePath)) {
    cached = {
      blockedCategories: [],
      blockedCategoryContains: [],
      blockedBrands: [],
      blockedTitleKeywords: [],
      rules: {},
    };
    return cached;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const titleKeywords = [
    ...(parsed.blockedTitleKeywords || []),
    ...(parsed.excludeList || []),
  ]
    .map((k) => String(k).toLowerCase().trim())
    .filter(Boolean);

  cached = {
    blockedCategories: (parsed.blockedCategories || []).map(String),
    blockedCategoryContains: (parsed.blockedCategoryContains || []).map(String),
    blockedBrands: (parsed.blockedBrands || []).map(String),
    blockedTitleKeywords: [...new Set(titleKeywords)],
    structuredRules: parsed.structuredRules || {},
    rules: parsed.rules || {},
  };
  return cached;
}

export function clearExcludeListCache() {
  cached = null;
}

/**
 * @param {string} text
 */
export function normalizeBrand(text) {
  return normalizeForMatch(text);
}
