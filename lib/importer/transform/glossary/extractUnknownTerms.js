import fs from "fs/promises";
import path from "path";
import { streamOcioStockRows } from "../../connectors/ociostock/streamCsv.js";
import { mapOcioStockRow } from "../../connectors/ociostock/csvFieldMap.js";
import { getDefaultConfig } from "../../config.js";

async function loadDictionary(sourceLang) {
  const p = path.join(process.cwd(), "lib/importer/transform/glossary/titles.json");
  const raw = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(raw);
  const mappings = parsed[sourceLang] || {};
  return Object.keys(mappings).map(k => k.toLowerCase());
}

async function loadBrandsAndFranchises() {
  const p = path.join(process.cwd(), "data/server/marketSettings.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    return [...(parsed.vipBrands || []), ...(parsed.vipLicences || [])].map(b => b.toLowerCase());
  } catch {
    return [];
  }
}

export async function extractUnknownTerms(sourceLang = "es", limit = 500) {
  const knownTerms = await loadDictionary(sourceLang);
  const knownBrands = await loadBrandsAndFranchises();
  
  // Sort known terms by length so we match longer phrases first (if they contain spaces)
  const allKnown = [...knownTerms, ...knownBrands].sort((a, b) => b.length - a.length);

  const wordCounts = new Map();

  await streamOcioStockRows({
    onRow: async (rawRow) => {
      const record = mapOcioStockRow(rawRow);
      if (!record?.title) return;

      let title = record.title.toLowerCase();

      // 1. Remove known multi-word or single-word phrases
      for (const known of allKnown) {
        if (!known) continue;
        // Basic naive replace - assumes safe characters mostly
        const re = new RegExp(`\\b${known.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "g");
        title = title.replace(re, " ");
      }

      // 2. Remove punctuation, numbers, single letters, symbols
      title = title.replace(/[0-9]+/g, " "); // remove numbers
      title = title.replace(/[^\p{L}\s]/gu, " "); // remove non-letters (keep unicode letters)
      title = title.replace(/\b\p{L}{1,2}\b/gu, " "); // remove 1 or 2 letter words (cm, mm, el, la, de, en)

      // 3. Tokenize remaining words
      const words = title.split(/\s+/).filter(w => w.trim().length > 2);

      for (const word of words) {
        const count = wordCounts.get(word) || 0;
        wordCounts.set(word, count + 1);
      }
    }
  });

  // Sort by frequency
  const sorted = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));

  const outPath = path.join(getDefaultConfig().paths.data, "unknown_terms.json");
  await fs.writeFile(outPath, JSON.stringify(sorted, null, 2));

  return {
    totalExtracted: sorted.length,
    topTerms: sorted.slice(0, 20),
    savedTo: outPath
  };
}

// Allow running via CLI directly: node lib/importer/transform/glossary/extractUnknownTerms.js
if (process.argv[1] && process.argv[1].endsWith("extractUnknownTerms.js")) {
  console.log("Extracting unknown terms from CSV...");
  extractUnknownTerms().then((res) => {
    console.log(`Saved top ${res.totalExtracted} terms to ${res.savedTo}`);
    console.table(res.topTerms);
  }).catch(console.error);
}
