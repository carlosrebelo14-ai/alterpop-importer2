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
    // Censo de 16/09/2026 sobre os 45 produtos Banpresto ACTIVE na loja (não só o
    // catálogo Prisma) — cobertura medida a 39/45; os 6 sem linha ficam null de
    // propósito (ver amostra em manufacturer-line-census.js). "Log Stories" tem de vir
    // ANTES de "World Collectable Figure": há título com as duas ("World Collectable
    // Figure Log Stories ..."), e Log Stories é a sub-linha mais específica.
    { line: "Log Stories", needles: ["log stories"] },
    { line: "World Collectable Figure", needles: ["world collectable", "wcf"] },
    { line: "Battle Record", needles: ["battle record"] },
    // "DXF The Grandline Series" e "Grandline Series" sozinho são a mesma linha — DXF
    // (Dramatic X Figure) é a marca do formato, Grandline Series o nome da linha
    // dentro dela; nunca aparece "DXF" sem "Grandline Series" no feed de hoje.
    { line: "Grandline Series", needles: ["grandline series"] },
    { line: "Grandista", needles: ["grandista"] },
    { line: "King of Artist", needles: ["king of artist"] },
    // "Senkokkei" é erro de escrita do fornecedor para "Senkozekkei" (falta "ze") — não
    // é variação de espaçamento/pontuação, precisa do needle próprio.
    { line: "Senkozekkei", needles: ["senkozekkei", "senkokkei"] },
    { line: "Maximatic", needles: ["maximatic"] },
    { line: "The Shukko", needles: ["shukko"] },
    { line: "Fluffy Puffy", needles: ["fluffy puffy"] },
    { line: "Dioramatic", needles: ["dioramatic"] },
    // Menos específica — bandeira genérica do Ichiban Kuji, cai por último. Substring
    // puro (não regex \b): "fIchibansho" (erro de escrita do fornecedor, sem espaço
    // antes do I maiúsculo) normaliza para "fichibansho", que CONTÉM "ichibansho" — bate
    // certo sem precisar de needle extra. Coberto pelo teste "typo do fornecedor" no
    // ficheiro de testes.
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
  // P3 (ADENDA 3/5, 17/09/2026) — "Rides" não é ruído sem informação nenhuma: é a linha
  // "POP! Rides" da Funko (veículo + figura), o mesmo padrão de reestruturação de frase
  // do fornecedor que motivou entrar em NOISE_PREFIXES (franchiseResolver.server.js).
  // A remoção do título fica — "Rides" continua sem informação de FORMATO — mas a
  // informação de LINHA não se perde, passa a viver aqui, mesmo espírito da Tarefa 34
  // (formatExtractor) para FORMAT_PREFIXES. Corre sobre o título BRUTO (antes do
  // titleCleaner), por isso vê "Rides" mesmo depois de entrar em NOISE_PREFIXES.
  [normalizeVendor("Funko")]: [{ line: "POP! Rides", needles: ["rides"] }],
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

/**
 * R2 (auditoria live, 17/09/2026) — formato implícito pela manufacturer_line, usado só
 * pelo formatExtractor quando o título não dá formato nenhum (ex.: "One Piece Monkey D
 * Luffy Gear 5 WCF Special 13cm" — WCF é "World Collectable Figure", mas a palavra
 * "figure" não aparece no título).
 *
 * Fecha só as linhas confirmadas como sendo SEMPRE figura — nunca um fabricante
 * inteiro por omissão. Banpresto e Tamashii Nations fazem só figuras (todas as linhas
 * do mapa contam); NECA e McFarlane Toys têm catálogo misto, por isso só entram as
 * linhas específicas dadas no briefing (Ultimate / DC Multiverse) — as restantes linhas
 * desses dois fabricantes (Theatrical Edition, Elite Edition, Cube Qubi, …) ficam de
 * fora até haver sinal de que são sempre figura.
 */
const FIGURE_ONLY_LINES_BY_VENDOR = {
  // null = todas as linhas deste fabricante contam como figura.
  [normalizeVendor("Banpresto")]: null,
  [normalizeVendor("Tamashii Nations")]: null,
  [normalizeVendor("NECA")]: new Set(["Ultimate"]),
  [normalizeVendor("McFarlane Toys")]: new Set(["DC Multiverse"]),
};

/**
 * @param {{ vendor?: string|null, title?: string }} product
 * @returns {boolean} true se a manufacturer_line resolvida para este produto é uma
 *  linha conhecida como só-figuras (R2).
 */
export function isKnownFigureOnlyManufacturerLine(product) {
  const key = normalizeVendor(product?.vendor);
  if (!(key in FIGURE_ONLY_LINES_BY_VENDOR)) return false;

  const line = extractManufacturerLine(product);
  if (!line) return false;

  const allow = FIGURE_ONLY_LINES_BY_VENDOR[key];
  return allow === null || allow.has(line);
}
