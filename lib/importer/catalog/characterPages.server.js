/**
 * characterPages — planeamento puro do ciclo de vida dos metaobjects `character` (B7,
 * secção 6 do arranque, 17/09/2026). Sem I/O: recebe o estado já lido da loja/Prisma e
 * devolve a lista de ações. Quem chama (character-pages-sync.js) é que fala com a
 * Shopify — aqui só a decisão.
 *
 * Limiar: 1 ou mais produtos ACTIVE publicados no Online Store (decisão de 27/10/2026, era 3) (o catálogo Prisma não conta —
 * quem monta `liveCounts` já filtrou para SKUs hoje ACTIVE, como no character-backfill.js).
 *
 * Ciclo de vida (secção 6):
 *  - Chega ao limiar, sem metaobject prévio  → "create"      (ACTIVE, escreve title/universe/products)
 *  - Chega ao limiar, já DRAFT               → "reactivate"  (mesmo handle, volta a ACTIVE)
 *  - Continua acima do limiar, já ACTIVE         → "update"      (products pode ter mudado)
 *  - Desce abaixo do limiar, já ACTIVE      → "set-draft"   (DRAFT; products NÃO se mexe —
 *                                                        fica com a última composição)
 *  - Nunca teve metaobject, abaixo do limiar         → "skip"        (nada a fazer, nunca existiu)
 *  - >128 produtos                     → "error"       (nunca truncar, erro visível)
 */
import { CHARACTER_VOCABULARY, CHARACTER_ALIASES, EPONYM_CANDIDATES, EPONYM_OVERRIDES } from "./characterVocabulary.js";
import { handleCanonico, toHandle } from "./characterResolver.server.js";

/** Decisão do arquiteto, 27/10/2026: o limiar passa de 3 para 1 (I2 do veredicto). */
export const CHARACTER_THRESHOLD = 1;
export const CHARACTER_PRODUCTS_MAX = 128;

const OVERRIDDEN_EPONYMS = new Set(EPONYM_OVERRIDES.map((o) => o.nome));
const BLOCKED_EPONYMS = new Set(EPONYM_CANDIDATES.filter((c) => !OVERRIDDEN_EPONYMS.has(c.nome)).map((c) => c.nome));

/** handle -> { nome, universo } para todo o vocabulário passagem A (espelha exactamente
 *  os nomes que characterResolver.server.js pode devolver — mesma exclusão de epónimos). */
export function buildCharacterCatalog() {
  const byHandle = new Map();
  for (const entry of CHARACTER_VOCABULARY) {
    for (const nome of entry.nomes) {
      if (BLOCKED_EPONYMS.has(nome)) continue;
      const handle = handleCanonico(nome);
      // Título do metaobject = o nome ou alias cujo slug é o handle (ex.: Luffy para luffy).
      const nomeHandle = [nome, ...(CHARACTER_ALIASES[nome] || [])].find((n) => toHandle(n) === handle) ?? nome;
      if (!byHandle.has(handle)) byHandle.set(handle, { nome: nomeHandle, universos: [] });
      const info = byHandle.get(handle);
      if (!info.universos.includes(entry.universo)) info.universos.push(entry.universo);
    }
  }
  return byHandle;
}

/**
 * @param {Object} input
 * @param {Map<string, { universo: string, productSkus: string[] }>} input.liveCounts
 *   handle -> universo + SKUs ACTIVE que resolveram para esse handle
 * @param {Map<string, { id: string, status: 'ACTIVE'|'DRAFT' }>} input.existing
 *   handle -> metaobject já existente na loja (ausente = nunca criado)
 * @returns {Array<{ handle: string, nome?: string, universo?: string, action: string, targetStatus?: string, count: number, productSkus?: string[], error?: string }>}
 */
export function planCharacterMetaobjects({ liveCounts, existing }) {
  const catalog = buildCharacterCatalog();
  const handles = new Set([...liveCounts.keys(), ...existing.keys()]);
  const actions = [];

  for (const handle of handles) {
    const info = catalog.get(handle);
    const live = liveCounts.get(handle) || null;
    const count = live?.productSkus?.length || 0;
    const ex = existing.get(handle) || null;
    // Vários universos por personagem (decisão do arquiteto, 28/10/2026): união do vocabulário e das ligações.
    const universos = [...new Set([...(info?.universos || []), ...(live?.universos || []), ...(live?.universo ? [live.universo] : [])])];
    const universo = universos[0] ?? null;
    const nome = info?.nome ?? handle;

    if (count > CHARACTER_PRODUCTS_MAX) {
      actions.push({
        handle,
        nome,
        universo,
        action: "error",
        count,
        error: `${count} produtos > limite de ${CHARACTER_PRODUCTS_MAX} (list.max) — nunca truncar`,
      });
      continue;
    }

    if (count >= CHARACTER_THRESHOLD) {
      actions.push({
        handle,
        nome,
        universo,
        universos,
        action: ex ? (ex.status === "ACTIVE" ? "update" : "reactivate") : "create",
        targetStatus: "ACTIVE",
        count,
        productSkus: live.productSkus,
      });
      continue;
    }

    if (ex && ex.status === "ACTIVE") {
      actions.push({
        handle,
        nome,
        universo,
        action: "set-draft",
        targetStatus: "DRAFT",
        count,
        // products NÃO muda — mantém a última composição (secção 6).
      });
      continue;
    }

    actions.push({
      handle,
      nome,
      universo,
      action: "skip",
      count,
    });
  }

  for (const a of actions) if (!a.universos) a.universos = a.universo ? [a.universo] : [];
  return actions.sort((a, b) => a.handle.localeCompare(b.handle));
}

/**
 * `alterpop.characters` por coleção Universe — só os handles que ficam (ou continuam)
 * `ACTIVE` depois do plano acima, do maior para o menor número de produtos (secção 6).
 * @param {Array<ReturnType<typeof planCharacterMetaobjects>[number]>} actions
 * @returns {Map<string, string[]>} universo -> handles ACTIVE, ordenados
 */
export function planUniverseCharacterCollections(actions) {
  const byUniverso = new Map();
  for (const a of actions) {
    if (a.targetStatus !== "ACTIVE") continue;
    for (const universo of a.universos ?? (a.universo ? [a.universo] : [])) {
      if (!byUniverso.has(universo)) byUniverso.set(universo, []);
      byUniverso.get(universo).push({ handle: a.handle, count: a.count });
    }
  }
  const plan = new Map();
  for (const [universo, list] of byUniverso) {
    list.sort((x, y) => y.count - x.count || x.handle.localeCompare(y.handle));
    plan.set(universo, list.map((x) => x.handle));
  }
  return plan;
}
