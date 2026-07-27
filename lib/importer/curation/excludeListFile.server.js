import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { clearExcludeListCache } from "./loadExcludeList.server.js";

export function excludeListFilePath() {
  return path.join(getDefaultConfig().paths.serverData, "exclude-list.json");
}

/**
 * @returns {Promise<string>}
 */
export async function readExcludeListJson() {
  try {
    const raw = await fs.readFile(excludeListFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return JSON.stringify(
        {
          version: 1,
          blockedCategories: [],
          blockedCategoryContains: [],
          blockedBrands: [],
          blockedTitleKeywords: [],
          excludeList: [],
        },
        null,
        2
      );
    }
    throw err;
  }
}

/**
 * @param {string} jsonText
 */
export async function writeExcludeListJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("JSON inválido no exclude-list.");
  }

  parsed.updatedAt = new Date().toISOString().slice(0, 10);

  const filePath = excludeListFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
  await fs.rename(tmp, filePath);
  clearExcludeListCache();
  return parsed;
}
