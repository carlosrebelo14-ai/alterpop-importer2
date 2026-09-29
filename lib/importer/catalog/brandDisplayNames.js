/**
 * C2 (briefing 29/09/2026, "catálogo limpo") — nome de marca para o cliente.
 *
 * O feed traz o vendor em maiúsculas ("BANPRESTO", "SD TOYS"). O cliente vê o nome do
 * MAPA, nunca um Title Case automático (daria "Sd Toys", como já aparecia nas tags).
 *
 * Regra que não muda: a CHAVE continua a ser o valor do feed. Tudo o que é interno
 * (resolver de franquia, tier do fabricante, manufacturer_line, formato, curadoria,
 * filtros do painel) compara pelo vendor do feed guardado em CatalogProduct.vendor. O
 * nome do mapa só existe na fronteira da Shopify: campo vendor do produto,
 * ociostock.brand, e o texto/link de marca na descrição.
 *
 * Vendor fora do mapa: publica com o valor do feed e dá o aviso VENDOR_UNMAPPED
 * (prePublishChecks.server.js). Acrescentar ao mapa é decisão, não automático.
 *
 * Puro. Testado em scripts/tests/brand-display-names.test.js.
 */

/** Chave do feed (maiúsculas, espaços simples) → nome para o cliente. */
export const BRAND_DISPLAY_NAMES = Object.freeze({
  "BANDAI HOBBY": "Bandai Hobby",
  BANPRESTO: "Banpresto",
  "DIAMOND SELECT": "Diamond Select",
  ERIK: "Erik",
  FUNKO: "Funko",
  HASBRO: "Hasbro",
  "JAKKS PACIFIC": "Jakks Pacific",
  MINIX: "Minix",
  PLASTOY: "Plastoy",
  RAVENSBURGER: "Ravensburger",
  "SD TOYS": "SD Toys",
  "STAR ACE": "Star Ace",
});

/** Chave de comparação do vendor do feed: trim, espaços simples, maiúsculas. */
export function brandKey(vendor) {
  return String(vendor ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * @param {string|null|undefined} vendor valor do feed (CatalogProduct.vendor)
 * @returns {{ key: string, name: string|null, mapped: boolean }}
 *   name = nome do mapa; fora do mapa, o valor do feed tal como veio (trim); sem vendor, null.
 */
export function resolveBrandDisplayName(vendor) {
  const key = brandKey(vendor);
  if (!key) return { key, name: null, mapped: false };
  const mappedName = BRAND_DISPLAY_NAMES[key];
  if (mappedName) return { key, name: mappedName, mapped: true };
  return { key, name: String(vendor).trim(), mapped: false };
}

/** Token do link de marca tal como buildProductDescriptionHtml o escreve, com a aspa
 *  de fecho do href — sem ela, "filter.p.vendor=FUNKO" apanhava também o início de
 *  "filter.p.vendor=FUNKO%20SPAIN". */
export function vendorLinkToken(vendor) {
  return `filter.p.vendor=${encodeURIComponent(String(vendor ?? "").trim())}"`;
}

/**
 * Guarda do vendor-backfill: entre `original` e `updated` só pode mudar o link de marca.
 * Tirando todos os tokens (antigo de um lado, novo do outro), o resto tem de ser igual,
 * e o número de links tem de ser o mesmo.
 */
export function onlyVendorLinkChanged(original, updated, oldToken, newToken) {
  const count = (s, t) => s.split(t).length - 1;
  if (count(original, oldToken) !== count(updated, newToken)) return false;
  if (count(updated, oldToken) !== 0) return false;
  return original.split(oldToken).join("") === updated.split(newToken).join("");
}

/**
 * C2 (ajuste de 29/09) — troca SÓ o link filter.p.vendor=<CHAVE> por
 * filter.p.vendor=<NOME> codificado na descrição. O texto visível da marca não muda
 * (fica para a republicação, que reescreve a descrição inteira).
 * @returns {{ ok: boolean, html: string, replaced: number, reason: string|null }}
 *   ok=false → o produto é recusado (nem vendor nem descrição mudam).
 */
export function rewriteVendorLink(html, fromVendor, toVendor, guard = onlyVendorLinkChanged) {
  const original = String(html ?? "");
  const oldToken = vendorLinkToken(fromVendor);
  const newToken = vendorLinkToken(toVendor);
  const replaced = original.split(oldToken).length - 1;
  if (replaced === 0) return { ok: true, html: original, replaced: 0, reason: null };
  if (original.includes(newToken)) {
    return { ok: false, html: original, replaced: 0, reason: "a descrição já tem o link novo — troca ambígua" };
  }
  const updated = original.split(oldToken).join(newToken);
  if (!guard(original, updated, oldToken, newToken)) {
    return { ok: false, html: original, replaced: 0, reason: "a descrição mudava fora do link de marca" };
  }
  return { ok: true, html: updated, replaced, reason: null };
}

/**
 * Plano do vendor-backfill.js. Só produtos cujo vendor do feed está no mapa e cujo
 * vendor live ainda não é o nome do mapa. Fora do mapa → unmapped (não toca).
 * sync_locked → de fora sem includeLocked.
 * Inclui a troca do link de marca na descrição (rewriteVendorLink); produto cuja
 * descrição mudaria fora do link é recusado inteiro (refused).
 * @param {Array<{ productId: string, handle: string, sku: string|null, liveVendor: string|null,
 *                 feedVendor: string|null, descriptionHtml?: string, syncLocked?: boolean }>} products
 * @param {{ includeLocked?: boolean }} [opts]
 */
export function planVendorBackfill(products, opts = {}) {
  const updates = [];
  const unmapped = [];
  const lockedSkipped = [];
  const refused = [];
  let alreadyOk = 0;
  let noVendor = 0;
  for (const p of products || []) {
    // Chave: vendor do feed (Prisma); sem linha no catálogo, o vendor live (ainda em
    // maiúsculas do feed nos produtos por migrar).
    const source = p.feedVendor || p.liveVendor;
    const resolved = resolveBrandDisplayName(source);
    if (!resolved.key) {
      noVendor += 1;
      continue;
    }
    if (!resolved.mapped) {
      unmapped.push({ ...p, key: resolved.key });
      continue;
    }
    if (p.liveVendor === resolved.name) {
      alreadyOk += 1;
      continue;
    }
    // O link na descrição foi escrito com o vendor live (valor do feed) — troca-se esse.
    const link = rewriteVendorLink(p.descriptionHtml, p.liveVendor, resolved.name);
    const entry = {
      productId: p.productId,
      handle: p.handle,
      sku: p.sku,
      from: p.liveVendor,
      to: resolved.name,
      linksReplaced: link.replaced,
      // Só vai no productUpdate quando mudou; senão o input fica { id, vendor }.
      descriptionHtml: link.replaced > 0 ? link.html : null,
    };
    if (!link.ok) {
      refused.push({ ...entry, reason: link.reason });
      continue;
    }
    if (p.syncLocked && !opts.includeLocked) lockedSkipped.push(entry);
    else updates.push(entry);
  }
  return {
    updates,
    unmapped,
    lockedSkipped,
    refused,
    alreadyOk,
    noVendor,
    processed: updates.length + unmapped.length + lockedSkipped.length + refused.length + alreadyOk + noVendor,
  };
}
