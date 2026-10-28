/**
 * characterCandidates — extrai, de um título de produto, o nome candidato a personagem
 * (pipeline de vocabulário, 28/10/2026). Puro, sem I/O. Heurística para revisão humana:
 * a saída é uma lista para o arquiteto e o Carlos aprovarem, nunca entra sozinha no vocabulário.
 *
 * Ordem: tira a franquia, o vendor, medidas, formato e linha; corta nos separadores; o que
 * sobra são no máximo 4 palavras iniciais com maiúscula.
 */

/** Palavras de formato e de produto que não são nomes. Minúsculas, sem acentos. */
const DESCRITORES = new Set([
  "figure", "figures", "figura", "figuras", "statue", "estatua", "statues", "funko", "pop", "vinyl",
  "action", "figurine", "replica", "lightsaber", "sabre", "plush", "peluche", "keychain", "llavero",
  "mug", "taza", "puzzle", "lamp", "lampara", "calendar", "calendario", "bookends", "deluxe", "chase",
  "limited", "edition", "exclusive", "exclusiva", "collectible", "coleccionable", "box", "caja",
  "set", "pack", "bundle", "vol", "volume", "mini", "bust", "busto", "diorama", "playset", "series",
  "serie", "with", "and", "the", "of", "de", "del", "la", "el", "en", "para", "con", "by", "in", "new",
  "ver", "version", "scale", "cm", "mm", "inch", "pvc", "plastic",
  // Restos de franquia que sobravam nos títulos (ronda 1, 28/10/2026).
  "kaisen", "shippuden", "disney", "pixar", "marvel", "legends", "dc", "comics",
  "teenage", "mutant", "hedgehog", "bros", "z", "gt",
]);

const SEPARADORES = /\s[-–—|]\s|[:(\[,/]|\s\+\s|&/;

function semAcentos(s) {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Nome em forma de título a partir de um segmento, ou null. */
function nomeDoSegmento(segmento) {
  const palavras = segmento
    .replace(/[^\p{L}\p{N}' -]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const nome = [];
  for (const w of palavras) {
    const base = semAcentos(w).replace(/[^a-z0-9]/g, "");
    if (!base) continue;
    if (DESCRITORES.has(base) || /^\d+$/.test(base)) {
      if (nome.length) break;
      continue;
    }
    nome.push(w);
    if (nome.length === 4) break;
  }
  if (!nome.length) return null;
  return nome.map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

/**
 * @param {string} title
 * @param {{ franchisePatterns?: string[], vendor?: string|null }} [opts]
 * @returns {string|null} nome candidato em forma de título, ou null
 */
export function extractCandidateName(title, { franchisePatterns = [], vendor = null } = {}) {
  let t = String(title ?? "");
  for (const p of [...franchisePatterns, "Lord of the Rings", "The Lord of the Rings"]) {
    if (!p) continue;
    t = t.replace(new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "giu"), " ");
  }
  if (vendor) {
    const v = String(vendor).trim();
    if (v) t = t.replace(new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "giu"), " ");
  }
  // medidas: 18cm, 10 x 5 x 3 cm, 7"
  t = t.replace(/\b\d+(?:[.,]\d+)?\s*(?:cm|mm|in|inch|")\b/giu, " ");
  t = t.replace(/\b\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?(?:\s*x\s*\d+(?:[.,]\d+)?)?\b/giu, " ");
  // tenta cada segmento entre separadores; o primeiro que der nome ganha
  for (const segmento of t.split(SEPARADORES)) {
    const nome = nomeDoSegmento(segmento);
    if (nome) return nome;
  }
  return null;
}
