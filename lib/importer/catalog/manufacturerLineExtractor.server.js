/**
 * manufacturerLineExtractor — B6 (briefing backend, 16/09/2026).
 *
 * Deriva `alterpop.manufacturer_line` — a linha de produto DENTRO de um fabricante (ex.:
 * "Ichibansho" ou "Grandista" dentro de Banpresto), a partir do título. NUNCA chamar
 * "line" sozinho: esse nome já existe (franchiseLines.js, sub-divisão de um UNIVERSO —
 * "The Mandalorian" dentro de "Star Wars") e é um conceito diferente. manufacturer_line
 * é sub-divisão de FABRICANTE, não de franquia.
 *
 * Vocabulário fechado, por fabricante, mesmo espírito do formatExtractor.server.js
 * (Tarefa 34): ordenado por especificidade — quando duas linhas aparecem no mesmo
 * título (ex. "Dragon Ball Mystical Adventure ... Ichibansho"), a mais específica
 * (Mystical Adventure, um lançamento temático dentro do guarda-chuva Ichiban Kuji)
 * vence sobre a mais genérica (Ichibansho). Um produto só leva UMA linha.
 *
 * Construído a partir de censo real sobre os 1 940 produtos Banpresto do feed
 * (scripts/catalog/manufacturer-line-census.js, 16/09/2026) — não é lista inventada.
 * "Mystical Adventure" e "Duel Memories" têm frequência baixa no feed de hoje (1 e 3
 * produtos) mas entram por serem os exemplos dados no briefing; as restantes vieram do
 * ranking de frases por frequência, filtrado contra nomes de franquia (ruído).
 *
 * Fabricante fora deste mapa fica SEM LINHA (null) — nunca inventa. Mesma regra do
 * manufacturerTierResolver.server.js: lista fechada, sem fallback genérico.
 */

function normalizeVendor(vendor) {
  return String(vendor || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function normText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** fabricante normalizado → regras de linha, ordenadas por especificidade (mais
 *  específica primeiro dentro do array). */
const MANUFACTURER_LINE_RULES = {
  [normalizeVendor("Banpresto")]: [
    { line: "Mystical Adventure", needles: ["mystical adventure"] },
    { line: "Duel Memories", needles: ["duel memories"] },
    { line: "Dueling to the Future", needles: ["dueling to the future"] },
    { line: "Glitter & Glamorous", needles: ["glitter and glamorous", "glitter and glamour", "glitter glamorous", "glitter glamour", "glitter glamours"] },
    { line: "Vibration Stars", needles: ["vibration stars"] },
    { line: "Solid Edge Works", needles: ["solid edge works", "solid edge work"] },
    { line: "Match Makers", needles: ["match makers"] },
    { line: "Sofvimates", needles: ["sofvimates"] },
    { line: "Espresto", needles: ["espresto"] },
    { line: "Grandista", needles: ["grandista"] },
    // Menos específica — bandeira genérica do Ichiban Kuji, cai por último.
    { line: "Ichibansho", needles: ["ichibansho"] },
  ],
  // Censo de 16/09/2026 sobre os 299 produtos Tamashii Nations do feed (proposto pelo
  // Carlos como o exemplo do modelo — Bandai/S.H.Figuarts/COLLECTOR). "figuarts"/
  // "figurarts" como substring apanha TODAS as variantes de espaçamento/pontuação do
  // fornecedor ("S.H.Figuarts", "S.H. Figuarts", "SH Figuarts", "SHFiguarts", e o erro
  // de escrita "S.H. Figurarts") sem precisar de as listar uma a uma — por isso tem de
  // vir depois de "Figuarts Zero", que também contém "figuarts".
  [normalizeVendor("Tamashii Nations")]: [
    { line: "Figuarts Zero", needles: ["figuarts zero"] },
    { line: "S.H.MonsterArts", needles: ["monsterarts"] },
    { line: "S.H.Figuarts", needles: ["figuarts", "figurarts"] },
    { line: "Robot Spirits", needles: ["robot spirits"] },
    { line: "Soul of Chogokin", needles: ["chogokin"] },
    { line: "Saint Cloth Myth", needles: ["saint cloth myth", "scm"] },
    { line: "Gundam Universe", needles: ["gundam universe"] },
    { line: "Changearts", needles: ["changearts"] },
  ],
  // Censo de 16/09/2026 sobre os 68 produtos NECA — "Ultimate" domina (26/68, 38%),
  // linha real e inequívoca. Toony Terrors/Retro/Clothed/Body Knockers ficaram de fora:
  // 1–2 ocorrências cada, sem exemplo explícito do briefing a justificar incluir como
  // Duel Memories/Mystical Adventure em Banpresto — fica para quando houver mais sinal.
  [normalizeVendor("NECA")]: [
    { line: "Ultimate", needles: ["ultimate"] },
  ],
  // Censo de 16/09/2026 sobre os 35 produtos McFarlane Toys.
  [normalizeVendor("McFarlane Toys")]: [
    { line: "DC Multiverse", needles: ["multiverse"] },
    { line: "Theatrical Edition", needles: ["theatrical edition"] },
    { line: "Elite Edition", needles: ["elite edition"] },
    { line: "Cube Qubi", needles: ["cube qubi"] },
  ],
};

/** Valores possíveis, para dry-run/censo — mesma convenção de FORMAT_VALUES. */
export const MANUFACTURER_LINE_VALUES = Array.from(
  new Set(Object.values(MANUFACTURER_LINE_RULES).flatMap((rules) => rules.map((r) => r.line)))
);

/**
 * @param {{ vendor?: string|null, title?: string }} product
 * @returns {string|null} nome canónico da linha, ou null se o fabricante não está no
 *  mapa ou nenhuma needle bate.
 */
export function extractManufacturerLine(product) {
  const rules = MANUFACTURER_LINE_RULES[normalizeVendor(product?.vendor)];
  if (!rules) return null;

  const title = normText(product?.title);
  if (!title) return null;

  for (const { line, needles } of rules) {
    if (needles.some((n) => title.includes(n))) return line;
  }
  return null;
}
