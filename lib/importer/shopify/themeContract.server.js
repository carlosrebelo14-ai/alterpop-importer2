/**
 * Guarda do tema (Decisão 32): lê o tema MAIN e valida o contrato de themeContract.js.
 *
 * SÓ LEITURA. Este módulo emite apenas queries ao Admin GraphQL (themes, theme.files,
 * metafieldDefinitions, currentAppInstallation): nenhuma mutation, nenhuma escrita em assets,
 * templates ou settings do tema (scripts/tests/theme-contract.test.js garante-o). A única
 * escrita é o snapshot da app em data/theme-contract/<loja>.json.
 *
 * Fluxo de getThemeContractStatus:
 *   1. scope read_themes concedido? (currentAppInstallation.accessScopes) — senão `scope_missing`
 *   2. tema MAIN (themes) — `updatedAt` igual ao do snapshot guardado reaproveita os factos
 *      dos ficheiros; diferente (ou refresh pedido) reconstrói o snapshot e reavalia
 *   3. definições de metafield e (opcional) a guarda de franquias lidas em cada avaliação
 *   4. avaliação pura (evaluateThemeContract) e gravação do resultado
 *
 * assertThemeContractValid é o portão do lote de publicação: só recusa com THEME_GUARD=ON, e
 * só por contrato inválido ou erro técnico — avisos nunca bloqueiam.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDefaultConfig } from "../config.js";
import { checkAccessScopes } from "./accessScopesGuard.js";
import { computeFranchiseConditionsDiff } from "./franchiseConditionsGuard.server.js";
import { isShopifyScopeError } from "../../session/loadOfflineSessionForShop.server.js";
import {
  THEME_CONTRACT_VERSION,
  THEME_STATUS,
  REQUIRED_THEME_SCOPES,
  contractFilenames,
  sectionFilenames,
  extractTemplateFacts,
  extractSettingsFacts,
  sectionMentionsFilters,
  declaredStorefrontDefinitions,
  definitionId,
  evaluateThemeContract,
  isThemeGuardEnforced,
  SETTINGS_DATA_FILE,
} from "./themeContract.js";

const Q_SCOPES = `query ThemeContractScopes { currentAppInstallation { accessScopes { handle } } }`;
const Q_THEMES = `query ThemeContractThemes { themes(first: 25) { nodes { id name role updatedAt } } }`;
const Q_FILES = `
  query ThemeContractFiles($id: ID!, $filenames: [String!]) {
    theme(id: $id) {
      id name role updatedAt
      files(first: 250, filenames: $filenames) {
        nodes { filename checksumMd5 size updatedAt body { ... on OnlineStoreThemeFileBodyText { content } } }
      }
    }
  }
`;
const Q_DEFINITIONS = `
  query ThemeContractDefinitions($ownerType: MetafieldOwnerType!, $after: String) {
    metafieldDefinitions(first: 100, after: $after, ownerType: $ownerType, namespace: "alterpop") {
      pageInfo { hasNextPage endCursor }
      nodes { namespace key ownerType access { storefront } }
    }
  }
`;

/** Erro do portão do lote. `code` e `status` HTTP sugerido para a rota. */
export class ThemeContractError extends Error {
  /** @param {'THEME_CONTRACT_INVALID'|'THEME_SCOPE_MISSING'|'THEME_CONTRACT_UNAVAILABLE'} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ThemeContractError";
    this.code = code;
    this.status = code === "THEME_CONTRACT_UNAVAILABLE" ? 502 : 409;
    Object.assign(this, extra);
  }
}

function snapshotPath(shop) {
  return path.join(getDefaultConfig().paths.data, "theme-contract", `${shop.replace(/\//g, "_")}.json`);
}

/** @returns {Promise<object|null>} null se ainda não existe; ficheiro ilegível lança. */
async function loadStored(shop) {
  let raw;
  try {
    raw = await fs.readFile(snapshotPath(shop), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`FALHA DE LEITURA do snapshot do tema (${snapshotPath(shop)}): ${err.message}`);
  }
}

async function saveStored(shop, value) {
  const file = snapshotPath(shop);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Estado guardado, sem rede — para o painel (`themeCompatibility` em /api/products). Nunca
 * lança: snapshot ilegível ou inexistente dá `unknown` com a razão.
 * @param {string} shop
 */
export async function readStoredThemeStatus(shop) {
  try {
    const stored = await loadStored(shop);
    if (!stored?.result) return { status: THEME_STATUS.UNKNOWN, blocking: [], warnings: [], themeUpdatedAt: null, checkedAt: null, reason: "contrato do tema ainda não lido" };
    return {
      status: stored.result.status,
      blocking: stored.result.blocking || [],
      warnings: stored.result.warnings || [],
      themeUpdatedAt: stored.themeUpdatedAt ?? null,
      checkedAt: stored.checkedAt ?? null,
      themeName: stored.themeName ?? null,
    };
  } catch (err) {
    return { status: THEME_STATUS.UNKNOWN, blocking: [], warnings: [], themeUpdatedAt: null, checkedAt: null, reason: err?.message || String(err) };
  }
}

/** Scopes concedidos de facto (a declaração no toml só prova o pedido). */
export async function checkThemeScope(client) {
  const data = await client.graphql(Q_SCOPES);
  const granted = (data?.currentAppInstallation?.accessScopes || []).map((s) => s.handle);
  return checkAccessScopes(granted, REQUIRED_THEME_SCOPES);
}

async function readFiles(client, themeId, filenames) {
  const data = await client.graphql(Q_FILES, { id: themeId, filenames });
  const out = new Map();
  for (const n of data?.theme?.files?.nodes || []) out.set(n.filename, n);
  return out;
}

const bodyOf = (node) => (typeof node?.body?.content === "string" ? node.body.content : null);

/** Lê o tema MAIN. Sem tema MAIN devolve null. */
export async function fetchMainTheme(client) {
  const themes = (await client.graphql(Q_THEMES))?.themes?.nodes || [];
  return themes.find((t) => t.role === "MAIN") || null;
}

/**
 * Constrói o snapshot de factos do tema (pedidos de leitura apenas).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {{ id: string, name: string, updatedAt: string }} theme
 */
export async function buildThemeSnapshot(client, theme) {
  const nodes = await readFiles(client, theme.id, contractFilenames());
  /** @type {Record<string, object>} */
  const files = {};
  for (const f of contractFilenames()) {
    const node = nodes.get(f);
    if (!node) {
      files[f] = { present: false };
    } else if (f === SETTINGS_DATA_FILE) {
      files[f] = { present: true, checksumMd5: node.checksumMd5 ?? null, ...extractSettingsFacts(bodyOf(node)) };
    } else if (f.endsWith(".json")) {
      files[f] = { present: true, checksumMd5: node.checksumMd5 ?? null, ...extractTemplateFacts(bodyOf(node)) };
    } else {
      files[f] = { present: true, checksumMd5: node.checksumMd5 ?? null };
    }
  }

  const sectionTypes = new Set();
  for (const f of Object.keys(files)) for (const t of files[f].sectionTypes || []) sectionTypes.add(t);
  /** @type {Record<string, object>} */
  const sections = {};
  if (sectionTypes.size) {
    const wanted = [...sectionTypes].slice(0, 100).flatMap((t) => sectionFilenames(t));
    const secNodes = await readFiles(client, theme.id, wanted);
    for (const f of wanted) {
      const node = secNodes.get(f);
      sections[f] = node ? { present: true, mentionsFilters: sectionMentionsFilters(bodyOf(node)) } : { present: false };
    }
  }
  return { themeId: theme.id, themeName: theme.name, themeUpdatedAt: theme.updatedAt, files, sections };
}

/** Definições alterpop.* da loja (PRODUCT e COLLECTION), paginadas. */
export async function fetchAlterpopDefinitions(client) {
  const out = new Map();
  for (const ownerType of ["PRODUCT", "COLLECTION"]) {
    let after = null;
    for (let page = 0; page < 20; page++) {
      const conn = (await client.graphql(Q_DEFINITIONS, { ownerType, after }))?.metafieldDefinitions;
      for (const n of conn?.nodes || []) out.set(definitionId(n), n);
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  }
  return out;
}

/**
 * Estado do contrato do tema, com leitura da loja.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 * @param {{ refresh?: boolean, includeFranchise?: boolean }} [opts]
 *   refresh: ignora o snapshot e relê os ficheiros do tema; includeFranchise: corre também a
 *   guarda de franquias (o lote de publicação corre-a à parte, por isso omite-a aqui)
 * @returns {Promise<{ status: string, blocking: object[], warnings: object[], themeId?: string, themeName?: string,
 *   themeUpdatedAt?: string, checkedAt: string, rebuilt: boolean, missingScopes?: string[] }>}
 */
export async function getThemeContractStatus(client, shop, opts = {}) {
  const checkedAt = new Date().toISOString();
  const scope = await checkThemeScope(client);
  if (!scope.ok) {
    const result = {
      status: THEME_STATUS.SCOPE_MISSING,
      blocking: [{ code: "THEME_SCOPE_MISSING", message: `Falta o scope ${scope.missing.join(", ")}: reautoriza a app (Definições → Permissões) para ler o tema.` }],
      warnings: [],
      missingScopes: scope.missing,
      checkedAt,
      rebuilt: false,
    };
    await persist(shop, null, result, checkedAt);
    return result;
  }

  let theme;
  let snapshot;
  let rebuilt = false;
  try {
    theme = await fetchMainTheme(client);
    if (!theme) {
      const result = { ...evaluateThemeContract({ snapshot: null, definitions: null }), checkedAt, rebuilt: false };
      await persist(shop, null, result, checkedAt);
      return result;
    }
    const stored = await loadStored(shop).catch(() => null); // ilegível → reconstrói
    const reusable =
      !opts.refresh && stored?.snapshot && stored.contractVersion === THEME_CONTRACT_VERSION && stored.snapshot.themeId === theme.id && stored.snapshot.themeUpdatedAt === theme.updatedAt;
    if (reusable) {
      snapshot = stored.snapshot;
    } else {
      snapshot = await buildThemeSnapshot(client, theme);
      rebuilt = true;
    }
  } catch (err) {
    if (isShopifyScopeError(err)) {
      const result = {
        status: THEME_STATUS.SCOPE_MISSING,
        blocking: [{ code: "THEME_SCOPE_MISSING", message: `Sem acesso ao tema (${err.message}). Reautoriza a app para read_themes.` }],
        warnings: [],
        missingScopes: REQUIRED_THEME_SCOPES,
        checkedAt,
        rebuilt: false,
      };
      await persist(shop, null, result, checkedAt);
      return result;
    }
    throw err;
  }

  const definitions = await fetchAlterpopDefinitions(client);
  const franchiseDiffs = opts.includeFranchise ? await computeFranchiseConditionsDiff(client) : null;
  const evaluated = evaluateThemeContract({ snapshot, definitions, franchiseDiffs });
  const result = { ...evaluated, themeId: snapshot.themeId, themeName: snapshot.themeName, themeUpdatedAt: snapshot.themeUpdatedAt, checkedAt, rebuilt };
  await persist(shop, snapshot, result, checkedAt);
  return result;
}

async function persist(shop, snapshot, result, checkedAt) {
  try {
    await saveStored(shop, {
      contractVersion: THEME_CONTRACT_VERSION,
      shop,
      checkedAt,
      themeUpdatedAt: snapshot?.themeUpdatedAt ?? null,
      themeName: snapshot?.themeName ?? null,
      snapshot,
      result: { status: result.status, blocking: result.blocking, warnings: result.warnings },
    });
  } catch (err) {
    // O snapshot é só cache e estado para o painel: não derruba a leitura.
    console.error(`[theme-contract] snapshot não gravado: ${err?.message || err}`);
  }
}

/** Relê o tema publicado (ignora o snapshot). */
export function refreshThemeContract(client, shop, opts = {}) {
  return getThemeContractStatus(client, shop, { ...opts, refresh: true });
}

/**
 * Portão do lote de publicação. Só atua com THEME_GUARD=ON (activação depois da
 * reautorização do scope). Recusa só por contrato inválido, scope em falta ou erro técnico;
 * avisos passam sempre.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 * @param {{ includeFranchise?: boolean, enforce?: boolean }} [opts] enforce: força o portão (testes)
 * @returns {Promise<object|null>} o estado, ou null quando o portão está desligado
 */
export async function assertThemeContractValid(client, shop, opts = {}) {
  if (!(opts.enforce ?? isThemeGuardEnforced())) return null;
  let status;
  try {
    status = await getThemeContractStatus(client, shop, { includeFranchise: opts.includeFranchise });
  } catch (err) {
    throw new ThemeContractError("THEME_CONTRACT_UNAVAILABLE", `Contrato do tema não lido (erro técnico): ${err?.message || err}`);
  }
  if (status.status === THEME_STATUS.SCOPE_MISSING) {
    throw new ThemeContractError("THEME_SCOPE_MISSING", status.blocking[0]?.message || "Falta o scope read_themes.", { themeContract: status });
  }
  if (status.status === THEME_STATUS.BLOCKED) {
    throw new ThemeContractError(
      "THEME_CONTRACT_INVALID",
      `Contrato do tema inválido (${status.blocking.length}): ${status.blocking.map((b) => b.message).join(" · ")}`,
      { themeContract: status }
    );
  }
  return status;
}

export { declaredStorefrontDefinitions, isThemeGuardEnforced };
