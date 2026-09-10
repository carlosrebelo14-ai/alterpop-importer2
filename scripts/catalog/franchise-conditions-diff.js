#!/usr/bin/env node
/**
 * ENTREGA 2 · Tarefa 4 — diff das condições versionadas vs as regras REAIS da Shopify.
 *
 * Corre ANTES de qualquer escrita de metafields (franchise-metafield-write, publish em
 * lote, etc.). Se a condição EQUALS de uma coleção Universe/Line não bater byte a byte
 * com franchiseConditions.js, o metafield escrito nunca casa e a sala fica vazia sem
 * erro visível — este script apanha isso.
 *
 * Comparação por CODE POINT: NÃO normaliza a condição da Shopify antes de comparar.
 * Também assinala:
 *   - coleção em falta (handle da lista sem coleção na loja)
 *   - regra PRODUCT_METAFIELD_DEFINITION em falta ou com metafield errado
 *   - templateSuffix diferente do esperado
 *   - coleção universe-room / line na loja sem entrada na lista versionada
 *   - NBSP / NFD dentro da lista versionada (assertConditionsNFC)
 *
 * DRY / read-only — nunca escreve. Sai != 0 se houver qualquer divergência.
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/franchise-conditions-diff.js
 *   node scripts/catalog/franchise-conditions-diff.js --json
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  FRANCHISE_CONDITIONS,
  FRANCHISE_CONDITION_HANDLES,
  assertConditionsNFC,
} from "../../lib/importer/catalog/franchiseConditions.js";
import {
  UNIVERSE_TEMPLATE_SUFFIX,
} from "../../lib/importer/catalog/franchiseUniverses.js";
import { LINE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseLines.js";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const LIST_QUERY = `
  query CondDiff($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title templateSuffix
        ruleSet {
          appliedDisjunctively
          rules { column relation condition conditionObject { ... on MetafieldDefinition { namespace key } } }
        }
      }
    }
  }
`;

async function fetchAll(client) {
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

/** code points de uma string, para diagnóstico ("Pokémon" vs "Pokémon"). */
const cps = (s) => [...String(s)].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");

async function main() {
  const nfcProblems = assertConditionsNFC();

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const collections = await fetchAll(client);
  const byHandle = new Map(collections.map((c) => [c.handle, c]));

  const diffs = [];

  for (const want of FRANCHISE_CONDITIONS) {
    const col = byHandle.get(want.handle);
    if (!col) {
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
    const mfName = mfRule.conditionObject
      ? `${mfRule.conditionObject.namespace}.${mfRule.conditionObject.key}`
      : "(desconhecido)";
    if (mfName !== want.metafield) {
      diffs.push({
        handle: want.handle, kind: want.kind,
        problem: `regra sobre ${mfName}, esperado ${want.metafield}`,
      });
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

  // Coleções Universe/Line na loja sem entrada na lista versionada.
  const strayTemplates = new Set([UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX]);
  const stray = collections.filter(
    (c) => strayTemplates.has(c.templateSuffix) && !FRANCHISE_CONDITION_HANDLES.has(c.handle)
  );

  if (JSON_OUT) {
    console.log(JSON.stringify({ shop: SHOP, nfcProblems, diffs, stray: stray.map((c) => c.handle) }, null, 2));
  } else {
    console.log(`=== franchise-conditions-diff (${SHOP}) ===`);
    console.log(`lista versionada: ${FRANCHISE_CONDITIONS.length} entradas · coleções na loja: ${collections.length}`);
    if (nfcProblems.length) {
      console.log(`\n⚠️  problemas na lista versionada (corrigir no repo):`);
      for (const p of nfcProblems) console.log(`  - ${p}`);
    }
    if (!diffs.length && !stray.length) {
      console.log(`\n✓ tudo alinhado — pode escrever metafields.`);
    } else {
      for (const d of diffs) {
        console.log(`\n✗ ${d.handle} [${d.kind}] — ${d.problem}`);
        if (d.want != null) {
          console.log(`    versionado: ${JSON.stringify(d.want)}   ${d.wantCps}`);
          console.log(`    shopify   : ${JSON.stringify(d.got)}   ${d.gotCps}`);
        }
      }
      for (const c of stray) {
        console.log(`\n✗ ${c.handle} — coleção ${c.templateSuffix} na loja sem entrada na lista versionada`);
      }
    }
  }

  if (nfcProblems.length || diffs.length || stray.length) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
