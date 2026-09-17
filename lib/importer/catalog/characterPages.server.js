/**
 * characterPages — planeamento puro do ciclo de vida dos metaobjects `character` (B7,
 * secção 6 do arranque, 17/09/2026). Sem I/O: recebe o estado já lido da loja/Prisma e
 * devolve a lista de ações. Quem chama (character-pages-sync.js) é que fala com a
 * Shopify — aqui só a decisão.
 *
 * Limiar: 3 ou mais produtos ACTIVE no Online Store (o catálogo Prisma não conta —
 * quem monta `liveCounts` já filtrou para SKUs hoje ACTIVE, como no character-backfill.js).
 *
 * Ciclo de vida (secção 6):
 *  - Chega a 3, sem metaobject prévio  → "create"      (ACTIVE, escreve title/universe/products)
 *  - Chega a 3, já DRAFT               → "reactivate"  (mesmo handle, volta a ACTIVE)
 *  - Continua em 3+, já ACTIVE         → "update"      (products pode ter mudado)
 *  - Desce abaixo de 3, já ACTIVE      → "set-draft"   (DRAFT; products NÃO se mexe —
 *                                                        fica com a última composição)
 *  - Nunca teve metaobject, <3         → "skip"        (nada a fazer, nunca existiu)
 *  - >128 produtos                     → "error"       (nunca truncar, erro visível)
 */
import { CHARACTER_VOCABULARY, EPONYM_CANDIDATES, EPONYM_OVERRIDES } from "./characterVocabulary.js";
import { toHandle } from "./characterResolver.server.js";

export const CHARACTER_THRESHOLD = 3;
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
      byHandle.set(toHandle(nome), { nome, universo: entry.universo });
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
    const universo = info?.universo ?? live?.universo ?? null;
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
    if (a.targetStatus !== "ACTIVE" || !a.universo) continue;
    if (!byUniverso.has(a.universo)) byUniverso.set(a.universo, []);
    byUniverso.get(a.universo).push({ handle: a.handle, count: a.count });
  }
  const plan = new Map();
  for (const [universo, list] of byUniverso) {
    list.sort((x, y) => y.count - x.count || x.handle.localeCompare(y.handle));
    plan.set(universo, list.map((x) => x.handle));
  }
  return plan;
}
