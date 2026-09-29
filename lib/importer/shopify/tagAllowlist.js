/**
 * Lista permitida de tags de produto — N4, opção A (decisão do Carlos, 29/09/2026).
 *
 * A auditoria de 27/09 e a medição do N4 (159 ACTIVE, 56 tags distintas, 0 coleções a
 * ler tags) mostraram categorias, marcas e universos sem padrão ("Onepiece" 44 vs
 * "One Piece" 4) a viver nas tags. A classificação vive nos metafields alterpop.*; as
 * tags ficam reduzidas a esta lista.
 *
 * Três consumidores, uma fonte:
 *   - buildShopifyProductTags (shopifyMapper.server.js) — o publisher só escreve isto;
 *   - TAG_OUTSIDE_ALLOWLIST no portão (pre-pilot-verify.js);
 *   - scripts/catalog/tags-cleanup.js (tagsRemove de tudo o resto).
 *
 * Puro — sem Shopify, sem fs. Testado em scripts/tests/tag-allowlist.test.js.
 */

/** A app marca os produtos que criou com "alterpop" (shopifyReset usa-a para os
 *  encontrar). Mais nenhuma. */
export const ALLOWED_PRODUCT_TAGS = Object.freeze(["alterpop"]);

const normalize = (tag) => String(tag ?? "").trim().toLowerCase();
const ALLOWED_NORMALIZED = new Set(ALLOWED_PRODUCT_TAGS.map(normalize));

/** A Shopify trata tags sem distinção de maiúsculas — "Alterpop" conta como permitida. */
export function isAllowedTag(tag) {
  return ALLOWED_NORMALIZED.has(normalize(tag));
}

/** Tags de uma lista que estão fora da lista permitida, pela ordem original. */
export function tagsOutsideAllowlist(tags) {
  return (tags || []).filter((t) => !isAllowedTag(t));
}

/**
 * TAG_OUTSIDE_ALLOWLIST — produtos com pelo menos uma tag fora da lista.
 * @param {Array<{ handle: string, sku?: string|null, tags: string[] }>} products
 * @returns {{ ok: boolean, offenders: Array<{ handle: string, sku: string|null, tags: string[] }>,
 *             distinctTags: Array<{ tag: string, count: number }> }}
 */
export function findTagsOutsideAllowlist(products) {
  const offenders = [];
  const counts = new Map();
  for (const p of products || []) {
    const outside = tagsOutsideAllowlist(p.tags);
    if (!outside.length) continue;
    offenders.push({ handle: p.handle, sku: p.sku ?? null, tags: outside });
    for (const t of outside) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const distinctTags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { ok: offenders.length === 0, offenders, distinctTags };
}

/**
 * Plano do tags-cleanup.js. Só remove tags fora da lista; produtos com
 * ociostock.sync_locked=true ficam marcados e de fora, a menos que includeLocked.
 * @param {Array<{ productId: string, handle: string, sku?: string|null, tags: string[], syncLocked?: boolean }>} products
 * @param {{ includeLocked?: boolean }} [opts]
 */
export function planTagsCleanup(products, opts = {}) {
  const removals = [];
  const lockedSkipped = [];
  let clean = 0;
  for (const p of products || []) {
    const outside = tagsOutsideAllowlist(p.tags);
    if (!outside.length) {
      clean += 1;
      continue;
    }
    const entry = { productId: p.productId, handle: p.handle, sku: p.sku ?? null, tags: outside };
    if (p.syncLocked && !opts.includeLocked) lockedSkipped.push(entry);
    else removals.push(entry);
  }
  return {
    removals,
    lockedSkipped,
    clean,
    processed: removals.length + lockedSkipped.length + clean,
    tagsToRemove: removals.reduce((n, r) => n + r.tags.length, 0),
  };
}

/**
 * Sonda do código: o builder de tags, chamado com um produto cheio de sinais do feed
 * (vendor, refs, tokens de categoria, XOFF, OFERTAS, customTags), só pode devolver tags
 * da lista. Usada pelo tags-cleanup.js para recusar correr enquanto o código em
 * produção ainda gera tags fora da lista — senão o publisher repunha-as.
 * @param {(vendor: string, franchises: string[], customTags: string[], product: object) => string[]} buildTags
 * @returns {{ ok: boolean, produced: string[], outside: string[] }}
 */
export function probeTagBuilder(buildTags) {
  const produced = buildTags(
    "FUNKO",
    ["ONEPIECE", "ONE PIECE", "ANIME / MANGA", "XOFF", "OFERTAS", "POP CULTURE COLLECTIBLES"],
    ["tag-manual"],
    { title: "One Piece Luffy Figure", categoryMain: "ANIME / MANGA" },
  );
  const outside = tagsOutsideAllowlist(produced);
  return { ok: outside.length === 0, produced, outside };
}
