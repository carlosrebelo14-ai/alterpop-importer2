/**
 * productCharacterLinks — planeamento puro das ligações produto ↔ Character
 * (tabela `ProductCharacter`, PR 4, decisão de 27/10/2026). Sem I/O.
 *
 * Regras:
 *  - Origem "resolver": calculada por characterResolver a partir de titleOverride ?? originalTitle
 *    e de resolvedFranchise. Pode ser acrescentada e removida pelo resolver.
 *  - Origem "store": lida do alterpop.character já escrito na loja (backfill B1).
 *    NUNCA removida pelo resolver — só acrescenta. Sem isto, o primeiro ciclo do
 *    reconciliador esvazia os personagens LOTR já ligados e volta a criar o P3 (A4).
 *  - Um produto sem nenhum match do resolver não perde ligações store.
 */
import { resolveCharacters, toHandle } from "./characterResolver.server.js";
import { CHARACTER_VOCABULARY } from "./characterVocabulary.js";

export const ORIGEM_STORE = "store";
export const ORIGEM_RESOLVER = "resolver";

/** Universo com lista aprovada à parte (decisão do Carlos de 27/10/2026, lista D3). */
export const UNIVERSO_FILTRADO = "The Lord of the Rings";

/** Handles aprovados para o universo filtrado: a lista D3 do vocabulário. */
export const HANDLES_APROVADOS_FILTRADO = new Set(
  (CHARACTER_VOCABULARY.find((e) => e.universo === UNIVERSO_FILTRADO)?.nomes || []).map(toHandle),
);

/** Handle de um personagem do universo filtrado (LOTR). */
export function isHandleFiltrado(handle) {
  return HANDLES_APROVADOS_FILTRADO.has(handle);
}

/**
 * Filtro LOTR (B2, 27/10/2026): um personagem do universo filtrado só entra se estiver na lista
 * aprovada (`aprovadosFiltrado`, por defeito a lista D3). Os restantes universos não passam por
 * aqui.
 *
 * @param {Object} input
 * @param {Array<{ sku: string, originalTitle?: string|null, titleOverride?: string|null, resolvedFranchise?: string|null }>} input.products
 * @param {Map<string, Array<{ characterHandle: string, origem: string }>>} input.existingLinks
 *   sku -> ligações já gravadas em ProductCharacter
 * @param {Set<string>} [input.aprovadosFiltrado] handles aprovados para o universo filtrado
 * @returns {Array<{ sku: string, add: Array<{characterHandle: string, origem: string}>, remove: string[], resolved: string[]|null, excluded: string[], unchanged: boolean }>}
 */
export function planProductCharacterLinks({ products, existingLinks, aprovadosFiltrado = HANDLES_APROVADOS_FILTRADO }) {
  const plan = [];
  for (const p of products) {
    const resolvedAll = resolveCharacters({
      originalTitle: p.originalTitle,
      titleOverride: p.titleOverride,
      resolvedFranchise: p.resolvedFranchise,
    });
    const excluded = [];
    const resolved = resolvedAll
      ? resolvedAll.filter((h) => {
          if (isHandleFiltrado(h) && !aprovadosFiltrado.has(h)) {
            excluded.push(h);
            return false;
          }
          return true;
        })
      : null;
    const resolvedSet = new Set(resolved || []);
    const existing = existingLinks.get(p.sku) || [];
    const existingHandles = new Set(existing.map((l) => l.characterHandle));

    const add = [];
    for (const handle of resolvedSet) {
      if (!existingHandles.has(handle)) add.push({ characterHandle: handle, origem: ORIGEM_RESOLVER });
    }

    // Só remove ligações do próprio resolver que deixaram de bater. Store nunca sai daqui.
    const remove = existing
      .filter((l) => l.origem === ORIGEM_RESOLVER && !resolvedSet.has(l.characterHandle))
      .map((l) => l.characterHandle);

    plan.push({
      sku: p.sku,
      add,
      remove,
      resolved,
      excluded,
      unchanged: add.length === 0 && remove.length === 0,
    });
  }
  return plan;
}

/**
 * B1 — ligações já escritas na loja. `handles` vêm de alterpop.character já resolvido para
 * handles de metaobject. Devolve linhas prontas para ProductCharacter com origem "store".
 * @param {Array<{ sku: string, handles: string[], universeHandle?: string|null }>} rows
 */
export function storeLinkRows(rows) {
  const out = [];
  for (const r of rows) {
    for (const handle of new Set(r.handles || [])) {
      out.push({ sku: r.sku, characterHandle: handle, universeHandle: r.universeHandle ?? null, origem: ORIGEM_STORE });
    }
  }
  return out;
}

/**
 * Lista de produto → personagens (dry-run B2). Só produtos com pelo menos um personagem.
 * @param {ReturnType<typeof planProductCharacterLinks>} plan
 */
export function productToCharactersReport(plan) {
  return plan
    .filter((p) => p.resolved && p.resolved.length)
    .map((p) => ({ sku: p.sku, characters: p.resolved }));
}
