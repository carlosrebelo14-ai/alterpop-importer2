/**
 * Definições do N1 (briefing 27/09) — Novidades por metafield, em vez da tag
 * `new-arrival` que o newArrivalsSync reconciliava.
 *
 * P4 — PRECONDIÇÃO DE CRIAÇÃO. A Shopify recusa qualquer metafieldDefinitionUpdate a
 * uma definição usada numa regra de smart collection (provado a 27/09 com
 * alterpop.franchise; o Admin grava sem erro e sem efeito). Por isso:
 *   - is_new_arrival nasce JÁ com access.storefront PUBLIC_READ e
 *     smartCollectionCondition ligado — é a condição da coleção new-arrivals.
 *   - a regra só é aplicada depois de checkDefinitionReadyForCollectionRule dar ok,
 *     lido da loja por API (só a leitura por API conta como prova).
 *   - depois de a new-arrivals a usar, a definição fica fechada.
 *
 * Namespace `alterpop` é merchant-owned: access.admin nunca é declarado.
 */

/** @type {import('./metafieldSetup.js').MetafieldDefinitionShape} */
export const ALTERPOP_IS_NEW_ARRIVAL_DEFINITION = {
  namespace: "alterpop",
  key: "is_new_arrival",
  name: "New arrival",
  description:
    "true durante NEW_ARRIVAL_DAYS depois de alterpop.first_published_at. Escrito pelo publisher na primeira publicação e pelo ciclo trigger-sync (newArrivals.server.js). Condição da coleção new-arrivals.",
  ownerType: "PRODUCT",
  type: "boolean",
  access: { storefront: "PUBLIC_READ" },
  capabilities: { smartCollectionCondition: { enabled: true } },
};

/** @type {import('./metafieldSetup.js').MetafieldDefinitionShape} */
export const ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION = {
  namespace: "alterpop",
  key: "first_published_at",
  name: "First published at",
  description:
    "Data da primeira publicação no Online Store. Escrita uma vez (publisher, backfill ou ciclo trigger-sync) e nunca reescrita — uma republicação não a muda.",
  ownerType: "PRODUCT",
  type: "date_time",
  access: { storefront: "PUBLIC_READ" },
  capabilities: { smartCollectionCondition: { enabled: false } },
};

export const NEW_ARRIVALS_DEFINITIONS = [
  ALTERPOP_IS_NEW_ARRIVAL_DEFINITION,
  ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION,
];

/**
 * P4 — a definição lida da loja está pronta para ser condição de regra de coleção?
 * Tipo, acesso storefront e smartCollectionCondition têm de bater com a forma
 * declarada, porque depois da regra já não se mudam. Pura.
 *
 * @param {{ type: string, access?: { storefront?: string }, capabilities?: object }} def
 * @param {{ id?: string, type?: { name?: string }, access?: { storefront?: string }, capabilities?: object } | null} current
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkDefinitionReadyForCollectionRule(def, current) {
  if (!current?.id) return { ok: false, reasons: ["definição não existe na loja"] };
  const reasons = [];
  if (current.type?.name !== def.type) {
    reasons.push(`tipo ${current.type?.name} ≠ ${def.type}`);
  }
  const wantStorefront = def.access?.storefront ?? "NONE";
  if ((current.access?.storefront ?? "NONE") !== wantStorefront) {
    reasons.push(`storefront ${current.access?.storefront} ≠ ${wantStorefront}`);
  }
  if (current.capabilities?.smartCollectionCondition?.enabled !== true) {
    reasons.push("smartCollectionCondition desligado");
  }
  return { ok: reasons.length === 0, reasons };
}
