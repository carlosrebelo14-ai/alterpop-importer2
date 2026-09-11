/**
 * BRIEFING BACKEND · Tarefa 26 — guarda permanente.
 *
 * Versão reutilizável do diff da ENTREGA 2 · Tarefa 4 (scripts/catalog/franchise-conditions-diff.js),
 * extraída para poder ser chamada tanto pelo CLI como pelo publisher — "portão
 * obrigatório antes de qualquer escrita de metafields" (briefing), não só um script
 * que alguém tem de se lembrar de correr à mão.
 *
 * `computeFranchiseConditionsDiff(client)` — pura leitura, devolve os 3 tipos de
 * divergência (NFC, condição/coleção errada, coleção órfã). `assertFranchiseConditionsAligned(client)`
 * lança se houver qualquer uma; chamada UMA VEZ por corrida em runApprovedShopifySync,
 * antes do loop de publish — nunca por produto (evitaria N chamadas GraphQL redundantes).
 */
import {
  FRANCHISE_CONDITIONS,
  FRANCHISE_CONDITION_HANDLES,
  assertConditionsNFC,
} from "../catalog/franchiseConditions.js";
import { UNIVERSE_TEMPLATE_SUFFIX } from "../catalog/franchiseUniverses.js";
import { LINE_TEMPLATE_SUFFIX } from "../catalog/franchiseLines.js";

const LIST_QUERY = `
  query CondGuard($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title templateSuffix
        ruleSet {
          appliedDisjunctively
          rules { column relation condition }
        }
      }
    }
  }
`;

async function fetchAllCollections(client) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 20; p++) {
    const data = await client.graphql(LIST_QUERY, { cursor });
    const conn = data?.collections;
    for (const n of conn?.nodes || []) out.push(n);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

const cps = (s) => [...String(s)].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @returns {Promise<{ nfcProblems: string[], diffs: object[], stray: object[], collectionsCount: number }>}
 */
export async function computeFranchiseConditionsDiff(client) {
  const nfcProblems = assertConditionsNFC();
  const collections = await fetchAllCollections(client);
  const byHandle = new Map(collections.map((c) => [c.handle, c]));
  const diffs = [];

  for (const want of FRANCHISE_CONDITIONS) {
    const col = byHandle.get(want.handle);
    if (!col) {
      // Universos dormentes (active: false, baseline < 10) não têm coleção de propósito.
      if (want.kind === "universe" && !want.active) continue;
      diffs.push({ handle: want.handle, kind: want.kind, problem: "coleção não existe na loja" });
      continue;
    }
    const rules = col.ruleSet?.rules || [];
    const mfRule = rules.find((r) => r.column === "PRODUCT_METAFIELD_DEFINITION");
    if (!mfRule) {
      diffs.push({
        handle: want.handle, kind: want.kind,
        problem: `sem regra PRODUCT_METAFIELD_DEFINITION (colunas: ${rules.map((r) => r.column).join(",") || "nenhuma"})`,
      });
      continue;
    }
    if (mfRule.relation !== "EQUALS") {
      diffs.push({ handle: want.handle, kind: want.kind, problem: `relation ${mfRule.relation}, esperado EQUALS` });
    }
    if (mfRule.condition !== want.condition) {
      diffs.push({
        handle: want.handle, kind: want.kind,
        problem: "condição não bate por code point",
        want: want.condition, wantCps: cps(want.condition),
        got: mfRule.condition, gotCps: cps(mfRule.condition),
      });
    }
    if ((col.templateSuffix || null) !== want.templateSuffix) {
      diffs.push({
        handle: want.handle, kind: want.kind,
        problem: `templateSuffix "${col.templateSuffix || ""}", esperado "${want.templateSuffix}"`,
      });
    }
  }

  const strayTemplates = new Set([UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX]);
  const stray = collections.filter(
    (c) => strayTemplates.has(c.templateSuffix) && !FRANCHISE_CONDITION_HANDLES.has(c.handle)
  );

  return { nfcProblems, diffs, stray, collectionsCount: collections.length };
}

/**
 * Portão obrigatório (Tarefa 26). Lança se houver QUALQUER divergência — universo
 * ativo na tabela sem coleção na loja, coleção Universe/Line na loja sem entrada na
 * tabela, condição/templateSuffix errado, ou problema de NFC na lista versionada.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function assertFranchiseConditionsAligned(client) {
  const result = await computeFranchiseConditionsDiff(client);
  const { nfcProblems, diffs, stray } = result;
  if (!nfcProblems.length && !diffs.length && !stray.length) return result;

  const lines = [];
  for (const p of nfcProblems) lines.push(`NFC: ${p}`);
  for (const d of diffs) lines.push(`${d.handle} [${d.kind}]: ${d.problem}`);
  for (const c of stray) lines.push(`${c.handle}: coleção ${c.templateSuffix} na loja sem entrada na lista versionada`);

  throw new Error(
    `franchise-conditions-diff falhou (${lines.length} divergência(s)) — publish abortado antes de escrever metafields:\n  ${lines.join("\n  ")}`
  );
}
