/* eslint-env node */
/**
 * Contrato do tema publicado (Decisão 32, briefing "Preço sem IVA e guarda do tema").
 *
 * A app só LÊ o tema MAIN e valida o que ela própria declara precisar dele. NUNCA escreve em
 * assets, templates ou settings do tema. Módulo puro, sem I/O: a leitura da loja e o snapshot
 * estão em themeContract.server.js.
 *
 * O contrato (declarado aqui, no repositório da app):
 *
 *   BLOQUEIA o lote de publicação
 *     - templates/collection.universe-room.json e templates/collection.line.json presentes
 *       (a variante .liquid também serve, como no script de auditoria original)
 *     - o template de produto usado existe (PRODUCT_TEMPLATE; o publisher não define
 *       templateSuffix, por isso é o template por omissão)
 *     - definições de metafield alterpop.* declaradas com acesso storefront PUBLIC_READ
 *       existem na loja e têm esse acesso (as declaradas NONE — franchise, line,
 *       manufacturer_line — ficam de fora de propósito: a Shopify recusa alterar definições
 *       usadas em regras de coleção)
 *     - handles e regras de Universe e Line batem com a tabela (guarda existente,
 *       franchiseConditionsGuard.server.js)
 *
 *   AVISA no staging, nunca bloqueia
 *     - config/settings_data.json ausente ou ilegível
 *     - secções referenciadas pelos templates sem ficheiro em sections/
 *     - template de coleção sem nenhuma secção que mencione filtros (heurística)
 *     - template JSON que não é JSON válido
 *
 * Mudança de `updatedAt` do tema reconstrói o snapshot e reavalia; sozinha não bloqueia.
 */
import { UNIVERSE_TEMPLATE_SUFFIX } from "../catalog/franchiseUniverses.js";
import { LINE_TEMPLATE_SUFFIX } from "../catalog/franchiseLines.js";
import { ALTERPOP_FORMAT_DEFINITION } from "./franchiseMetafieldDefinition.js";
import { NEW_ARRIVALS_DEFINITIONS } from "./newArrivalsDefinitions.js";
import { ALTERPOP_HERO_IMAGE_DEFINITION } from "./heroImageMetafieldDefinition.js";

/** Bump quando o contrato muda: invalida os snapshots guardados. */
export const THEME_CONTRACT_VERSION = 1;

export { REQUIRED_THEME_SCOPES } from "./accessScopesGuard.js";

/** Template de produto por omissão (o publisher não define templateSuffix). */
export const PRODUCT_TEMPLATE = "templates/product";

export const SETTINGS_DATA_FILE = "config/settings_data.json";

/** Estados: ok · warn (só avisos) · blocked · scope_missing · unknown (nunca lido). */
export const THEME_STATUS = Object.freeze({ OK: "ok", WARN: "warn", BLOCKED: "blocked", SCOPE_MISSING: "scope_missing", UNKNOWN: "unknown" });

export const THEME_CODES = Object.freeze({
  NO_MAIN_THEME: "NO_MAIN_THEME",
  TEMPLATE_MISSING: "TEMPLATE_MISSING",
  PRODUCT_TEMPLATE_MISSING: "PRODUCT_TEMPLATE_MISSING",
  DEFINITION_MISSING: "DEFINITION_MISSING",
  DEFINITION_STOREFRONT_ACCESS: "DEFINITION_STOREFRONT_ACCESS",
  FRANCHISE_GUARD: "FRANCHISE_GUARD",
  SETTINGS_DATA_MISSING: "SETTINGS_DATA_MISSING",
  SETTINGS_DATA_INVALID: "SETTINGS_DATA_INVALID",
  TEMPLATE_JSON_INVALID: "TEMPLATE_JSON_INVALID",
  SECTION_MISSING: "SECTION_MISSING",
  NO_FILTER_SECTION: "NO_FILTER_SECTION",
});

/** `THEME_GUARD=ON` liga a recusa de publicação pelo contrato (default desligada). */
export function isThemeGuardEnforced() {
  return String(process.env.THEME_GUARD ?? "").trim().toUpperCase() === "ON";
}

/** Templates de coleção exigidos (extensão .json; .liquid também serve). */
export const COLLECTION_TEMPLATES = Object.freeze([
  Object.freeze({ base: `templates/collection.${UNIVERSE_TEMPLATE_SUFFIX}`, label: "Universe" }),
  Object.freeze({ base: `templates/collection.${LINE_TEMPLATE_SUFFIX}`, label: "Line" }),
]);

/**
 * Definições `alterpop.*` que o tema lê na storefront: as declaradas PUBLIC_READ.
 * @returns {Array<{ namespace: string, key: string, ownerType: string }>}
 */
export function declaredStorefrontDefinitions() {
  return [ALTERPOP_FORMAT_DEFINITION, ...NEW_ARRIVALS_DEFINITIONS, ALTERPOP_HERO_IMAGE_DEFINITION]
    .filter((d) => d.access?.storefront === "PUBLIC_READ")
    .map((d) => ({ namespace: d.namespace, key: d.key, ownerType: d.ownerType }));
}

export const definitionId = (d) => `${d.ownerType}:${d.namespace}.${d.key}`;

const withExt = (base) => [`${base}.json`, `${base}.liquid`];

/** Nomes de ficheiro a pedir ao tema na primeira leitura. */
export function contractFilenames() {
  return [...COLLECTION_TEMPLATES.flatMap((t) => withExt(t.base)), ...withExt(PRODUCT_TEMPLATE), SETTINGS_DATA_FILE];
}

/** Ficheiros de secção possíveis para um tipo de secção referenciado por um template. */
export function sectionFilenames(type) {
  return [`sections/${type}.liquid`, `sections/${type}.json`];
}

/**
 * Factos de um template JSON (Online Store 2.0): válido? que tipos de secção referencia?
 * @param {string|null|undefined} body
 * @returns {{ jsonValid: boolean, sectionTypes: string[] }}
 */
export function extractTemplateFacts(body) {
  if (typeof body !== "string") return { jsonValid: false, sectionTypes: [] };
  try {
    const parsed = JSON.parse(body);
    const sections = parsed && typeof parsed === "object" ? parsed.sections : null;
    const types = new Set();
    if (sections && typeof sections === "object") {
      for (const s of Object.values(sections)) if (s && typeof s.type === "string" && s.type) types.add(s.type);
    }
    return { jsonValid: true, sectionTypes: [...types] };
  } catch {
    return { jsonValid: false, sectionTypes: [] };
  }
}

/** settings_data.json é JSON válido? (o conteúdo não é guardado: pode ser grande). */
export function extractSettingsFacts(body) {
  if (typeof body !== "string") return { jsonValid: false };
  try {
    JSON.parse(body);
    return { jsonValid: true };
  } catch {
    return { jsonValid: false };
  }
}

/** Heurística: o código da secção fala de filtros/facetas? */
export function sectionMentionsFilters(body) {
  return typeof body === "string" && /\bfacet|\bfilter/i.test(body);
}

/**
 * @typedef {{ code: string, message: string, file?: string, key?: string }} ThemeIssue
 * @typedef {{
 *   themeId: string, themeName: string, themeUpdatedAt: string,
 *   files: Record<string, { present: boolean, jsonValid?: boolean, sectionTypes?: string[] }>,
 *   sections: Record<string, { present: boolean, mentionsFilters?: boolean }>,
 * }} ThemeSnapshot
 */

/**
 * Avalia o contrato. Pura.
 * @param {{
 *   snapshot: ThemeSnapshot|null,
 *   definitions: Map<string, { access?: { storefront?: string } }>|null  chave definitionId()
 *   franchiseDiffs?: { diffs?: object[], stray?: object[], nfcProblems?: string[] }|null  saída de computeFranchiseConditionsDiff
 * }} input
 * @returns {{ status: string, blocking: ThemeIssue[], warnings: ThemeIssue[] }}
 */
export function evaluateThemeContract({ snapshot, definitions, franchiseDiffs = null }) {
  /** @type {ThemeIssue[]} */
  const blocking = [];
  /** @type {ThemeIssue[]} */
  const warnings = [];

  if (!snapshot) {
    blocking.push({ code: THEME_CODES.NO_MAIN_THEME, message: "Nenhum tema com role MAIN na loja — nada publicado." });
    return { status: THEME_STATUS.BLOCKED, blocking, warnings };
  }
  const files = snapshot.files || {};
  const sections = snapshot.sections || {};
  const hit = (base) => withExt(base).map((f) => ({ f, facts: files[f] })).find((x) => x.facts?.present) || null;

  // ── Bloqueia
  const collectionTemplatesFound = [];
  for (const t of COLLECTION_TEMPLATES) {
    const found = hit(t.base);
    if (!found) {
      blocking.push({
        code: THEME_CODES.TEMPLATE_MISSING,
        file: `${t.base}.json`,
        message: `Falta o template de coleção ${t.label} no tema "${snapshot.themeName}": ${t.base}.json (ou .liquid).`,
      });
    } else {
      collectionTemplatesFound.push({ ...t, ...found });
    }
  }
  const productTemplate = hit(PRODUCT_TEMPLATE);
  if (!productTemplate) {
    blocking.push({
      code: THEME_CODES.PRODUCT_TEMPLATE_MISSING,
      file: `${PRODUCT_TEMPLATE}.json`,
      message: `Falta o template de produto usado: ${PRODUCT_TEMPLATE}.json (ou .liquid).`,
    });
  }

  if (definitions) {
    for (const d of declaredStorefrontDefinitions()) {
      const live = definitions.get(definitionId(d));
      const name = `${d.namespace}.${d.key} (${d.ownerType})`;
      if (!live) {
        blocking.push({ code: THEME_CODES.DEFINITION_MISSING, key: name, message: `Definição ${name} não existe na loja.` });
      } else if (live.access?.storefront !== "PUBLIC_READ") {
        blocking.push({
          code: THEME_CODES.DEFINITION_STOREFRONT_ACCESS,
          key: name,
          message: `Definição ${name} sem acesso storefront PUBLIC_READ (tem ${live.access?.storefront ?? "NONE"}) — o tema não a consegue ler.`,
        });
      }
    }
  }

  if (franchiseDiffs) {
    const items = [
      ...(franchiseDiffs.nfcProblems || []).map((p) => String(p)),
      ...(franchiseDiffs.diffs || []).map((d) => `${d.handle}: ${d.problem}`),
      ...(franchiseDiffs.stray || []).map((s) => `${s.handle}: ${s.problem || "coleção sem entrada na tabela"}`),
    ];
    if (items.length) {
      blocking.push({
        code: THEME_CODES.FRANCHISE_GUARD,
        message: `Handles/regras de Universe e Line divergem da tabela (${items.length}): ${items.slice(0, 5).join("; ")}${items.length > 5 ? "…" : ""}`,
      });
    }
  }

  // ── Avisa
  const settings = files[SETTINGS_DATA_FILE];
  if (!settings?.present) {
    warnings.push({ code: THEME_CODES.SETTINGS_DATA_MISSING, file: SETTINGS_DATA_FILE, message: `${SETTINGS_DATA_FILE} não existe no tema.` });
  } else if (settings.jsonValid === false) {
    warnings.push({ code: THEME_CODES.SETTINGS_DATA_INVALID, file: SETTINGS_DATA_FILE, message: `${SETTINGS_DATA_FILE} não é JSON válido.` });
  }

  const jsonTemplates = [...collectionTemplatesFound, ...(productTemplate ? [{ base: PRODUCT_TEMPLATE, label: "produto", ...productTemplate, collection: false }] : [])].filter((t) => t.f.endsWith(".json"));
  const missingSections = new Set();
  for (const t of jsonTemplates) {
    if (t.facts.jsonValid === false) {
      warnings.push({ code: THEME_CODES.TEMPLATE_JSON_INVALID, file: t.f, message: `${t.f} não é JSON válido.` });
      continue;
    }
    const isCollection = t.collection !== false;
    let hasFilterSection = false;
    for (const type of t.facts.sectionTypes || []) {
      const sec = sectionFilenames(type).map((f) => sections[f]).find((s) => s?.present);
      if (!sec) {
        if (!missingSections.has(`${t.f}|${type}`)) {
          missingSections.add(`${t.f}|${type}`);
          warnings.push({ code: THEME_CODES.SECTION_MISSING, file: t.f, key: type, message: `${t.f} usa a secção «${type}» que não existe em sections/.` });
        }
      } else if (sec.mentionsFilters) {
        hasFilterSection = true;
      }
    }
    if (isCollection && (t.facts.sectionTypes || []).length && !hasFilterSection) {
      warnings.push({ code: THEME_CODES.NO_FILTER_SECTION, file: t.f, message: `${t.f}: nenhuma secção do template menciona filtros (heurística) — confirma que a coleção ${t.label} tem filtros.` });
    }
  }

  const status = blocking.length ? THEME_STATUS.BLOCKED : warnings.length ? THEME_STATUS.WARN : THEME_STATUS.OK;
  return { status, blocking, warnings };
}
