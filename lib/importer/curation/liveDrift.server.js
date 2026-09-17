/**
 * liveDrift — LIVE_DRIFT (ADENDA 5, briefing backend, 17/09/2026).
 *
 * A auditoria dava verde nos três casos abaixo enquanto a loja continuava errada:
 *   0192995218383  alterpop.format vazio (Prisma já tinha "Doll")
 *   4983164896497  alterpop.format vazio (Prisma já tinha "Figure", via R2)
 *   889698835947   alterpop.format vazio (Prisma já tinha "Figure", via R1)
 *
 * Causa: MISSING_FRANCHISE/MISSING_FORMAT em prePublishChecks.server.js só olham para o
 * payload RECONSTRUÍDO (o que deveria estar, segundo o Prisma) — assim que o Prisma tem
 * valor, ficam verdes, mesmo que o metafield na Shopify continue vazio de uma
 * publicação anterior (o backfill de resolvedFormat/resolvedManufacturerLine nunca
 * chama metafieldsSet, só grava no Prisma). Este módulo compara os dois lados que
 * importam de verdade: o esperado (payload) contra o real (Shopify).
 *
 * Função pura — quem lê os metafields da Shopify e monta `liveValues` é responsabilidade
 * de quem chama (live-publish-audit.js, live-metafield-reconcile.js, e o reconciliador
 * por ciclo do item 7, que alimenta o V13 com o mesmo código).
 */

/** field (chave do metafield alterpop.<field>) → chave correspondente no payload de
 *  buildPublishPayload(). Mesma ordem em que o publisher os escreve. */
export const LIVE_DRIFT_FIELDS = [
  { field: "franchise", payloadKey: "resolvedFranchise" },
  { field: "line", payloadKey: "resolvedLine" },
  { field: "format", payloadKey: "resolvedFormat" },
  { field: "manufacturer_line", payloadKey: "resolvedManufacturerLine" },
];

/**
 * @param {{ resolvedFranchise?: string|null, resolvedLine?: string|null, resolvedFormat?: string|null, resolvedManufacturerLine?: string|null }} payload
 * @param {{ franchise?: string|null, line?: string|null, format?: string|null, manufacturer_line?: string|null }} liveValues
 * @returns {{ code: "LIVE_DRIFT", field: string, live: string|null, expected: string|null }[]}
 */
export function computeLiveDrift(payload, liveValues) {
  const findings = [];
  for (const { field, payloadKey } of LIVE_DRIFT_FIELDS) {
    const expected = payload?.[payloadKey] ?? null;
    const live = liveValues?.[field] ?? null;
    if (expected !== live) {
      findings.push({ code: "LIVE_DRIFT", field, live, expected });
    }
  }
  return findings;
}
