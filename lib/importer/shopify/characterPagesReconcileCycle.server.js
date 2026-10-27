/**
 * characterPagesReconcileCycle — B7, passo 9 do arranque (17/09/2026): liga
 * character-pages-sync ao ciclo do trigger-sync, com o mesmo travão do reconciliador de
 * live-drift (liveDriftReconcileCycle.server.js).
 *
 * TRAVÃO — até MAX_CHARACTER_CHANGES_PER_CYCLE Characters alterados no ciclo (create,
 * reactivate, update ou set-draft — não skip nem error), aplica sozinho. Acima disso, não
 * escreve NADA e fica vermelho com a lista completa: um universo inteiro a publicar de
 * repente não deve criar/mudar dezenas de metaobjects sem ninguém ver antes.
 *
 * Handles com `error` (>128 produtos) nunca entram no travão nem são aplicados — são
 * sempre reportados à parte, o resto do ciclo continua.
 *
 * Escreve SÓ metaobjectUpsert e metafieldsSet (`alterpop.character`, `alterpop.characters`)
 * — nunca `productUpdate`.
 */
import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { planCharacterMetaobjects } from "../catalog/characterPages.server.js";
import {
  fetchActiveProducts,
  fetchExistingCharacters,
  buildLiveCounts,
  applyCharacterActions,
} from "./characterPagesSync.server.js";

/** Nomeada no topo do ficheiro, como o MAX_AUTO_RECONCILE do live-drift. */
export const MAX_CHARACTER_CHANGES_PER_CYCLE = 10;

function statePath() {
  return path.join(getDefaultConfig().paths.data, "character-pages-cycle-state.json");
}

/**
 * Decide o que fazer com o plano já calculado. Função pura — não sabe nada de
 * Shopify/Prisma/fs. Testável sem rede nem BD.
 * @param {Array<{ handle: string, action: string }>} actions
 * @returns {{ status: "green"|"yellow"|"red", toApply: object[], blocked: object[], errors: object[] }}
 */
export function decideCharacterCycleAction(actions) {
  const errors = actions.filter((a) => a.action === "error");
  const changing = actions.filter((a) => a.action === "create" || a.action === "reactivate" || a.action === "update" || a.action === "set-draft");

  if (!changing.length) {
    return { status: "green", toApply: [], blocked: [], errors };
  }
  if (changing.length > MAX_CHARACTER_CHANGES_PER_CYCLE) {
    return { status: "red", toApply: [], blocked: changing, errors };
  }
  return { status: "yellow", toApply: changing, blocked: [], errors };
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 */
export async function reconcileCharacterPagesCycle(client, shop) {
  const activeProducts = await fetchActiveProducts(client);
  const existing = await fetchExistingCharacters(client);
  const liveCounts = await buildLiveCounts(shop, activeProducts);
  const actions = planCharacterMetaobjects({ liveCounts, existing });

  const decision = decideCharacterCycleAction(actions);

  let applyResult = { applied: [], productWrites: 0, collectionWrites: 0, collectionsWritten: [] };
  const writeErrors = [];
  if (decision.status === "yellow") {
    try {
      applyResult = await applyCharacterActions(client, { actionsToApply: decision.toApply, liveCounts, existing, activeProducts });
    } catch (err) {
      writeErrors.push({ message: err?.message || String(err) });
    }
  }

  const state = {
    status: writeErrors.length ? "red" : decision.status,
    shop,
    ranAt: new Date().toISOString(),
    activeProductsCount: activeProducts.length,
    changed: applyResult.applied.map((a) => ({ handle: a.handle, action: a.action, gid: a.gid, count: a.count })),
    blocked: decision.blocked.map((a) => ({ handle: a.handle, action: a.action, count: a.count })),
    invalid: decision.errors.map((a) => ({ handle: a.handle, error: a.error })),
    productWrites: applyResult.productWrites,
    collectionWrites: applyResult.collectionWrites,
    writeErrors,
  };

  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");

  return state;
}

/** Lê o último estado gravado — para um futuro V no portão de saúde (ADENDA 9). */
export async function loadCharacterPagesCycleState() {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`FALHA DE LEITURA (${statePath()}): ${err?.message || err}`);
  }
}
