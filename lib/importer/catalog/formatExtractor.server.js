/**
 * formatExtractor — alterpop.format, C3 (briefing "catálogo limpo", 29/09/2026).
 *
 * Vocabulário novo, decidido pelo Carlos a 29/09. `Figure` sai: ≈144 dos 159 ACTIVE
 * tinham "Figure", e o filtro Format da loja não separava um Funko Pop de uma figura de
 * prémio Banpresto. Histórico: Tarefa 34 (Decisão 18) criou o extrator; D2 (ADENDA 4)
 * fixou valores só em inglês — continua.
 *
 * Ordem de decisão (primeira que bater ganha):
 *   1. palavra explícita no título do feed (FORMAT_TITLE_KEYWORDS);
 *   2. linha do fabricante no título (FORMAT_BY_LINE — Pop!, Ichibansho, Gallery);
 *   3. omissão por vendor (FORMAT_BY_VENDOR) — salvo se o título tiver uma palavra de
 *      NO_VENDOR_DEFAULT_KEYWORDS (produto que não é o formato típico da marca);
 *   4. nada → null, e o prePublishChecks dá MISSING_FORMAT.
 * Nunca usa tags. Vendor comparado pela chave do feed (brandKey), nunca pelo nome
 * mostrado ao cliente.
 *
 * Função pura, sem I/O. Testada em scripts/tests/format-extractor.test.js.
 */
import { brandKey } from "./brandDisplayNames.js";

/** Os 11 valores permitidos de alterpop.format. O format-backfill recusa correr se algum
 *  valor calculado estiver fora desta lista. */
export const FORMAT_VOCABULARY = Object.freeze([
  "Vinyl Figure",
  "Prize Figure",
  "Statue",
  "Action Figure",
  "Mini Figure",
  "Model Kit",
  "Plush",
  "Doll",
  "Puzzle",
  "Keychain",
  "Home & Gifts",
]);

/**
 * Regra 1 — palavra explícita no título. Uma lista por valor, pela ordem de prioridade
 * (a primeira linha que bater ganha): o mais específico/menos ambíguo primeiro.
 *   - Model Kit antes de tudo: "model kit" é inequívoco.
 *   - Keychain antes de Plush/Vinyl: "Pocket POP Keychain", "plush keychain" são porta-chaves.
 *   - Home & Gifts antes de Statue: um candeeiro em forma de estátua é um candeeiro.
 * As palavras do briefing: plush, puzzle, keychain, lamp, calendar, bookends, statue,
 * bust, diorama, model kit. Acrescentadas (ver PR): doll/muñeca (valor Doll, vinha do
 * vocabulário antigo), mug/taza e key hanger (Home & Gifts: canecas e porta-chaves de
 * parede, pela tabela de usos), action figure (valor Action Figure) e os equivalentes
 * em espanhol do feed.
 */
export const FORMAT_TITLE_KEYWORDS = Object.freeze([
  { format: "Model Kit", keywords: ["model kit", "plastic model", "maqueta"] },
  { format: "Keychain", keywords: ["keychain", "llavero"] },
  {
    format: "Home & Gifts",
    keywords: ["lamp", "lampara", "calendar", "calendario", "bookends", "bookend", "key hanger", "mug", "taza"],
  },
  { format: "Plush", keywords: ["plush", "peluche"] },
  { format: "Puzzle", keywords: ["puzzle", "jigsaw"] },
  { format: "Doll", keywords: ["doll", "muneca"] },
  { format: "Statue", keywords: ["statue", "estatua", "bust", "busto", "diorama"] },
  { format: "Action Figure", keywords: ["action figure"] },
]);

/**
 * Regra 2 — linha do fabricante no título. `vendor` = chave do feed (brandKey), ou null
 * para qualquer vendor. Pop! só conta na Funko ("pop" noutras marcas é "Pop Culture");
 * Gallery só na Diamond Select.
 */
export const FORMAT_BY_LINE = Object.freeze([
  { vendor: "FUNKO", keywords: ["pop"], format: "Vinyl Figure" },
  { vendor: null, keywords: ["ichibansho"], format: "Prize Figure" },
  { vendor: "DIAMOND SELECT", keywords: ["gallery"], format: "Statue" },
]);

/** Regra 3 — omissão por vendor (chave do feed). Só as omissões da tabela de usos do
 *  briefing. Vendor fora daqui sem pista no título fica vazio (MISSING_FORMAT). */
export const FORMAT_BY_VENDOR = Object.freeze({
  FUNKO: "Vinyl Figure",
  BANPRESTO: "Prize Figure",
  "BANDAI HOBBY": "Model Kit",
  MINIX: "Mini Figure",
  PLASTOY: "Mini Figure",
});

/** Produtos que não são o formato típico da marca: com uma destas palavras, a omissão
 *  por vendor não se aplica e o produto fica vazio (MISSING_FORMAT), em vez de, p. ex.,
 *  uma mochila Funko sair "Vinyl Figure". */
export const NO_VENDOR_DEFAULT_KEYWORDS = Object.freeze([
  "backpack",
  "mochila",
  "loungefly",
  "bag",
  "wallet",
  "blind box",
  "mystery",
  "pin",
  "t shirt",
  "camiseta",
  "poster",
]);

function normText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Singular e plural regular (+s) — o fornecedor escreve os dois ("2 figures", "lamps"). */
function variants(keyword) {
  return keyword.endsWith("s") ? [keyword] : [keyword, `${keyword}s`];
}

/** Palavra (ou frase) inteira no título normalizado. */
function titleHas(haystack, keywords) {
  return keywords.some((k) => variants(k).some((v) => haystack.includes(` ${v} `)));
}

/**
 * @param {{ title?: string, vendor?: string|null }} product título BRUTO do feed e vendor do feed
 * @returns {string|null} um valor de FORMAT_VOCABULARY, ou null.
 */
export function extractProductFormat(product = {}) {
  const haystack = ` ${normText(product.title)} `;
  const vendor = brandKey(product.vendor);

  for (const row of FORMAT_TITLE_KEYWORDS) {
    if (titleHas(haystack, row.keywords)) return row.format;
  }
  for (const row of FORMAT_BY_LINE) {
    if (row.vendor && row.vendor !== vendor) continue;
    if (titleHas(haystack, row.keywords)) return row.format;
  }
  const byVendor = FORMAT_BY_VENDOR[vendor];
  if (byVendor && !titleHas(haystack, NO_VENDOR_DEFAULT_KEYWORDS)) return byVendor;
  return null;
}

/** Compatibilidade com format-extract-dryrun.js e relatórios: os valores possíveis. */
export const FORMAT_VALUES = FORMAT_VOCABULARY;

/** Alias histórico (D2): a lista aprovada é o vocabulário. */
export const APPROVED_FORMAT_VALUES = FORMAT_VOCABULARY;
