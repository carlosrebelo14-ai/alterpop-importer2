import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, { entries: { source: string, target: string, re: RegExp }[], caseSensitive: boolean, knownEnglishWords: Set<string> }> | null} */
let cached = null;

/** Palavras EN comuns de catálogo que nunca devem ir para a API (evita chamadas desperdiçadas). */
const ENGLISH_CATALOG_ALLOWLIST = new Set([
  "the", "and", "of", "for", "with", "without", "in", "on",
  "new", "set", "mini", "deluxe", "premium", "edition", "collector",
  "official", "licensed", "size", "pack", "style", "vol", "volume",
  "part", "one", "large", "small", "color", "colors", "unisex",
]);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pluralização EN leve (cobre os sufixos mais comuns em nomes de produto). */
function pluralizeEnglish(word) {
  if (/[sxz]$/i.test(word) || /(ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function readJsonWithFallback(filename) {
  const p1 = path.join(process.cwd(), "lib", "importer", "transform", "glossary", filename);
  try {
    return JSON.parse(fs.readFileSync(p1, "utf8"));
  } catch {
    const p2 = path.join(process.cwd(), "lib/importer/transform/glossary", filename);
    return JSON.parse(fs.readFileSync(p2, "utf8"));
  }
}

function loadTitleGlossary(sourceLang) {
  if (cached && cached[sourceLang]) return cached[sourceLang];

  const titlesParsed = readJsonWithFallback("titles.json");
  let connectorsParsed = { [sourceLang]: {} };
  try {
    connectorsParsed = readJsonWithFallback("connectors.json");
  } catch {
    /* connectors.json opcional */
  }

  const caseSensitive = titlesParsed.settings?.caseSensitive === true;
  const mappings = {
    ...(connectorsParsed[sourceLang] || {}),
    ...(titlesParsed[sourceLang] || {}),
  };

  /** @type {Map<string, string>} chave normalizada -> target (para detetar duplicados antes de gerar plurais) */
  const bySource = new Map();
  for (const [source, target] of Object.entries(mappings)) {
    if (!source || !target) continue;
    bySource.set(source.trim().toLowerCase(), String(target));
  }

  // Auto-plural: para termos de uma só palavra, gera "Escudo"->"Escudos" sem
  // exigir entrada manual duplicada. Entradas manuais existentes têm prioridade
  // (nunca sobrescritas), incluindo plurais irregulares já listados (ex: Hucha/Huchas).
  for (const [source, target] of [...bySource.entries()]) {
    if (source.includes(" ")) continue; // só palavras simples, frases ficam como estão
    const pluralTarget = pluralizeEnglish(target);
    for (const pluralSource of [`${source}s`, `${source}es`]) {
      if (!bySource.has(pluralSource)) {
        bySource.set(pluralSource, pluralTarget);
      }
    }
  }

  // \b nativo do JS baseia-se em \w (ASCII), por isso trata letras acentuadas
  // (ñ, á, é, í, ó, ú...) como fronteira de palavra — "Muñeca" partia-se em
  // "Mu" + "ñ" + "eca", e "eca" batia por coincidência com entradas de uma só
  // palavra do glossário. Fronteira manual Unicode-aware (\p{L}\p{N}_) resolve.
  const entries = [...bySource.entries()]
    .map(([source, target]) => ({
      source,
      target,
      re: new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(source)}(?![\\p{L}\\p{N}_])`,
        caseSensitive ? "gu" : "giu"
      ),
    }))
    .sort((a, b) => b.source.length - a.source.length);

  const knownEnglishWords = new Set();
  for (const target of bySource.values()) {
    for (const word of target.toLowerCase().split(/\s+/)) {
      if (word) knownEnglishWords.add(word);
    }
  }

  if (!cached) cached = {};
  cached[sourceLang] = { entries, caseSensitive, knownEnglishWords };
  return cached[sourceLang];
}

/**
 * Aplica ao `target` o padrão de capitalização do `match` original
 * (TUDO MAIÚSCULAS -> maiúsculas; Primeira Maiúscula -> primeira maiúscula).
 * Partilhado entre o glossário determinístico e o fallback de API (camada 3)
 * para que o resultado final seja consistente independentemente da camada
 * que traduziu a palavra.
 * @param {string} match
 * @param {string} target
 */
export function applyCaseFromMatch(match, target) {
  if (match === match.toUpperCase()) return target.toUpperCase();
  if (match[0] === match[0].toUpperCase()) {
    return target.charAt(0).toUpperCase() + target.slice(1);
  }
  return target;
}

/**
 * Substitui termos conhecidos no título por equivalentes EN (glossary local:
 * termos de produto + conectores gramaticais + variantes plurais automáticas).
 * @param {string} [title]
 * @param {string} [sourceLang="es"]
 * @returns {string}
 */
export function translateTitleFromGlossary(title, sourceLang = "es") {
  if (!title?.trim()) return title || "";

  const { entries } = loadTitleGlossary(sourceLang);
  let result = title;

  for (const { re, target } of entries) {
    result = result.replace(re, (match) => applyCaseFromMatch(match, target));
  }

  // Remove consecutive duplicate words (e.g. "Figure Figure" -> "Figure")
  result = result.replace(/\b([A-Za-z]+)\s+\1\b/gi, "$1");
  // Normalize spaces
  result = result.replace(/\s+/g, " ").trim();

  return result;
}

/**
 * Palavras que sobraram depois do glossário e são candidatas a tradução via API
 * (camada 3 — fallback). Exclui vendor/franchise do próprio produto (nomes
 * próprios que nunca devem ser traduzidos), números, palavras curtas e
 * palavras que já sabemos ser inglês de catálogo.
 *
 * @param {string} text Título já processado pelo glossário (camadas 1+2)
 * @param {{ exclude?: string[], sourceLang?: string }} [opts]
 * @returns {string[]} palavras únicas, na forma original (para poderes fazer replace preservando o texto)
 */
export function findResidualWords(text, opts = {}) {
  if (!text?.trim()) return [];

  const { knownEnglishWords } = loadTitleGlossary(opts.sourceLang || "es");
  const excludeSet = new Set(
    (opts.exclude || [])
      .filter(Boolean)
      .flatMap((phrase) => String(phrase).toLowerCase().split(/\s+/))
  );

  const words = text.match(/\p{L}+/gu) || [];
  const seen = new Set();
  const residual = [];

  for (const word of words) {
    const lower = word.toLowerCase();
    if (word.length < 3) continue;
    if (seen.has(lower)) continue;
    if (knownEnglishWords.has(lower)) continue;
    if (ENGLISH_CATALOG_ALLOWLIST.has(lower)) continue;
    if (excludeSet.has(lower)) continue;
    seen.add(lower);
    residual.push(word);
  }

  return residual;
}
