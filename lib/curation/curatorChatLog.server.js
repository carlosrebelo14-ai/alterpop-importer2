import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../importer/config.js";

function historyPath(shop) {
  return path.join(
    getDefaultConfig().paths.serverData,
    `${shop.replace(/\//g, "_")}-curator-chat-history.jsonl`
  );
}

/**
 * @param {string} shop
 * @param {{
 *   role: 'user' | 'assistant',
 *   message: string,
 *   toolsUsed?: string[],
 *   productCount?: number,
 * }} entry
 */
export async function appendCuratorChatLog(shop, entry) {
  const row = {
    at: new Date().toISOString(),
    shop,
    ...entry,
  };
  await fs.mkdir(getDefaultConfig().paths.serverData, { recursive: true });
  await fs.appendFile(historyPath(shop), `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * @param {string} shop
 * @param {number} [limit]
 */
export async function listCuratorChatHistory(shop, limit = 100) {
  try {
    const raw = await fs.readFile(historyPath(shop), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line))
      .reverse();
  } catch {
    return [];
  }
}
