import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDefaultConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cached = null;

export function clearCurationCache() {
  cached = null;
}

/**
 * Normaliza texto para comparação (case-insensitive, espaços colapsados).
 * @param {string} text
 */
export function normalizeForMatch(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Expande categorias bloqueadas com variantes ES/EN do glossário.
 * @param {string[]} blockedList
 */
function buildBlockedCategorySet(blockedList) {
  const set = new Set();

  for (const item of blockedList) {
    const trimmed = String(item).trim();
    if (!trimmed) continue;
    set.add(normalizeForMatch(trimmed));
  }

  let glossaryFile = path.join(__dirname, "../transform/glossary/categories.json");
  if (!fs.existsSync(glossaryFile)) {
    glossaryFile = path.join(process.cwd(), "lib/importer/transform/glossary/categories.json");
  }

  try {
    const glossary = JSON.parse(fs.readFileSync(glossaryFile, "utf8"));
    const mappings = glossary.mappings || glossary;

    for (const blocked of blockedList) {
      const normBlocked = normalizeForMatch(blocked);
      for (const [es, en] of Object.entries(mappings)) {
        if (normalizeForMatch(es) === normBlocked || normalizeForMatch(en) === normBlocked) {
          set.add(normalizeForMatch(es));
          set.add(normalizeForMatch(en));
        }
      }
      // Variante OcioStock sem acentos (PAPELERIA / ESCOLAR)
      set.add(normBlocked.normalize("NFD").replace(/\p{M}/gu, ""));
    }
  } catch {
    /* glossário opcional para expansão */
  }

  for (const blocked of blockedList) {
    set.add(
      normalizeForMatch(blocked)
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
    );
  }

  return set;
}

/**
 * Carrega config/curation.json (cache em memória).
 */
export function loadCuration() {
  if (cached) return cached;

  const filePath = getDefaultConfig().paths.curation;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);

  const premiumBrands = (parsed.premiumBrands || parsed.allowedBrands || [])
    .map((b) => String(b).trim())
    .filter(Boolean);
  const allowedBrands = (parsed.allowedBrands || premiumBrands)
    .map((b) => String(b).trim())
    .filter(Boolean);
  const eliteMinNetPriceEur =
    parsed.eliteMinNetPriceEur != null ? Number(parsed.eliteMinNetPriceEur) : 15;
  let blockedCategories = (parsed.blockedCategories || [])
    .map((c) => String(c).trim())
    .filter(Boolean);

  const excludePath = path.join(getDefaultConfig().paths.serverData, "exclude-list.json");
  try {
    const excludeRaw = JSON.parse(fs.readFileSync(excludePath, "utf8"));
    const fromExclude = (excludeRaw.blockedCategories || []).map((c) => String(c).trim()).filter(Boolean);
    blockedCategories = [...new Set([...blockedCategories, ...fromExclude])];
  } catch {
    /* exclude-list opcional */
  }
  const priorityFranchises = (parsed.priorityFranchises || [])
    .map((f) => String(f).trim())
    .filter(Boolean);

  cached = {
    premiumBrands,
    allowedBrands,
    eliteMinNetPriceEur: Number.isFinite(eliteMinNetPriceEur) ? eliteMinNetPriceEur : 15,
    blockedCategories,
    priorityFranchises,
    premiumBrandsNorm: premiumBrands.map((b) => normalizeForMatch(b)),
    allowedBrandsNorm: new Set(allowedBrands.map((b) => normalizeForMatch(b))),
    priorityFranchisesNorm: priorityFranchises.map((f) => normalizeForMatch(f)),
    blockedCategoriesExpanded: buildBlockedCategorySet(blockedCategories),
  };

  return cached;
}
