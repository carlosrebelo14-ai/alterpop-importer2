import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {{ entries: { source: string, target: string, re: RegExp }[], caseSensitive: boolean } | null} */
let cached = null;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadTitleGlossary() {
  if (cached) return cached;

  const raw = fs.readFileSync(path.join(__dirname, "titles.json"), "utf8");
  const parsed = JSON.parse(raw);
  const mappings = parsed.mappings || parsed;
  const caseSensitive = parsed.settings?.caseSensitive === true;

  const entries = Object.entries(mappings)
    .filter(([k, v]) => k && v)
    .map(([source, target]) => ({
      source,
      target: String(target),
      re: new RegExp(`\\b${escapeRegExp(source.trim())}\\b`, caseSensitive ? "g" : "gi"),
    }))
    .sort((a, b) => b.source.length - a.source.length);

  cached = { entries, caseSensitive };
  return cached;
}

/**
 * Substitui termos ES conhecidos no título por equivalentes EN (glossary local).
 * @param {string} [title]
 * @returns {string}
 */
export function translateTitleFromGlossary(title) {
  if (!title?.trim()) return title || "";

  const { entries } = loadTitleGlossary();
  let result = title;

  for (const { re, target } of entries) {
    result = result.replace(re, (match) => {
      if (match === match.toUpperCase()) return target.toUpperCase();
      if (match[0] === match[0].toUpperCase()) {
        return target.charAt(0).toUpperCase() + target.slice(1);
      }
      return target;
    });
  }

  return result;
}
