import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, { entries: { source: string, target: string, re: RegExp }[], caseSensitive: boolean }> | null} */
let cached = null;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadTitleGlossary(sourceLang) {
  if (cached && cached[sourceLang]) return cached[sourceLang];

  let raw;
  const p1 = path.join(process.cwd(), "lib", "importer", "transform", "glossary", "titles.json");
  try {
    raw = fs.readFileSync(p1, "utf8");
  } catch {
    const p2 = path.join(process.cwd(), "lib/importer/transform/glossary/titles.json");
    raw = fs.readFileSync(p2, "utf8");
  }
  const parsed = JSON.parse(raw);
  const mappings = parsed[sourceLang] || {};
  const caseSensitive = parsed.settings?.caseSensitive === true;

  const entries = Object.entries(mappings)
    .filter(([k, v]) => k && v)
    .map(([source, target]) => ({
      source,
      target: String(target),
      re: new RegExp(`\\b${escapeRegExp(source.trim())}\\b`, caseSensitive ? "g" : "gi"),
    }))
    .sort((a, b) => b.source.length - a.source.length);

  if (!cached) cached = {};
  cached[sourceLang] = { entries, caseSensitive };
  return cached[sourceLang];
}

/**
 * Substitui termos conhecidos no título por equivalentes EN (glossary local).
 * @param {string} [title]
 * @param {string} [sourceLang="es"]
 * @returns {string}
 */
export function translateTitleFromGlossary(title, sourceLang = "es") {
  if (!title?.trim()) return title || "";

  const { entries } = loadTitleGlossary(sourceLang);
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

  // Remove consecutive duplicate words (e.g. "Figure Figure" -> "Figure")
  result = result.replace(/\b([A-Za-z]+)\s+\1\b/gi, "$1");
  // Normalize spaces
  result = result.replace(/\s+/g, " ").trim();

  return result;
}
