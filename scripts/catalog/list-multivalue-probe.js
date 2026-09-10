#!/usr/bin/env node
/**
 * BRIEFING passos 1-3 · Tarefa 2 (R1) — uma regra `EQUALS "Star Wars"` apanha um
 * produto cujo `alterpop.franchise` é a LISTA `["Star Wars","Mickey & Friends"]`?
 *
 * 1 produto DESCARTÁVEL, título neutro, sem refs relevantes.
 * Escreve alterpop.franchise com os 2 valores. Espera propagação. Verifica pertença a
 * `star-wars` e a `mickey-and-friends` por products(first:3) — NUNCA por productsCount.
 * Apaga o produto no fim.
 *
 * Handle real da coleção Mickey na loja = "mickey-and-friends" (o briefing diz
 * "mickey-friends"; uso o que existe, confirmado no inventário de 2026-09-10).
 *
 *   Aparece nas 2  → R1 fechado, crossover por lista suportado
 *   Aparece em 1   → PARAR, reportar qual e a ordem dos valores
 *   Nenhuma        → PARAR, bloqueia o modelo de crossover
 *
 * Correr na Fla:  node scripts/catalog/list-multivalue-probe.js  [--keep]  [--order reverse]
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const ORDER_REVERSE = args.indexOf("--order") >= 0 && args[args.indexOf("--order") + 1] === "reverse";
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const VALUES = ORDER_REVERSE ? ["Mickey & Friends", "Star Wars"] : ["Star Wars", "Mickey & Friends"];
const CHECK = [
  { handle: "star-wars", condition: "Star Wars" },
  { handle: "mickey-and-friends", condition: "Mickey & Friends" },
];

const CREATE = `mutation P_Create($input: ProductInput!){ productCreate(input:$input){ product{ id } userErrors{ field message } } }`;
const MF_SET = `mutation P_Mf($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ metafields{ namespace key type value } userErrors{ field message } } }`;
const COLL = `query P_Coll($h:String!){ collectionByHandle(handle:$h){ handle templateSuffix ruleSet{ appliedDisjunctively rules{ column relation condition } } products(first:3){ nodes{ id title } } } }`;
const DEL = `mutation P_Del($input: ProductDeleteInput!){ productDelete(input:$input){ deletedProductId userErrors{ field message } } }`;
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const stamp = Date.now();

  console.log(`=== list-multivalue-probe (${SHOP}) ===`);
  console.log(`valor da lista: ${JSON.stringify(VALUES)}\n`);

  const cr = await client.graphql(CREATE, { input: { title: `zzz-r1-multivalue neutral widget [${stamp}]`, status: "DRAFT" } });
  const id = cr.productCreate?.product?.id;
  if (!id) { console.error("create falhou:", JSON.stringify(cr.productCreate?.userErrors)); process.exit(1); }
  console.log(`produto descartável: ${id}`);

  const mf = await client.graphql(MF_SET, {
    m: [{ ownerId: id, namespace: "alterpop", key: "franchise", type: "list.single_line_text_field", value: JSON.stringify(VALUES) }],
  });
  const mfErr = mf.metafieldsSet?.userErrors || [];
  if (mfErr.length) { console.error("metafieldsSet userErrors:", JSON.stringify(mfErr)); }
  console.log(`alterpop.franchise escrito: ${mf.metafieldsSet?.metafields?.[0]?.value}`);

  console.log(`\n── polling pertença (até 180s) ──`);
  let snap = {};
  for (let attempt = 1; attempt <= 18; attempt++) {
    await sleep(10);
    snap = {};
    for (const c of CHECK) {
      const d = await client.graphql(COLL, { h: c.handle });
      const col = d.collectionByHandle;
      snap[c.handle] = col
        ? { members: (col.products?.nodes || []), has: (col.products?.nodes || []).some((n) => n.id === id), rule: col.ruleSet?.rules?.[0], tpl: col.templateSuffix || "∅", disj: col.ruleSet?.appliedDisjunctively }
        : null;
    }
    if (CHECK.every((c) => snap[c.handle]?.has)) { console.log(`  (ambas confirmadas ~${attempt * 10}s)`); break; }
    if (attempt === 18) console.log(`  (timeout 180s)`);
  }

  console.log(`\n── resultado por coleção (products(first:3)) ──`);
  for (const c of CHECK) {
    const s = snap[c.handle];
    if (!s) { console.log(`  ${c.handle}: NÃO EXISTE`); continue; }
    console.log(`  ${c.handle}  rule=${s.rule?.column} ${s.rule?.relation} ${JSON.stringify(s.rule?.condition)}  tpl=${s.tpl}`);
    console.log(`     contém o produto? ${s.has ? "SIM ✓" : "não ✗"}   (membros visíveis: ${s.members.map((m) => m.id.split("/").pop()).join(", ") || "nenhum"})`);
  }

  const hits = CHECK.filter((c) => snap[c.handle]?.has).map((c) => c.handle);
  console.log(`\n── veredicto R1 ──`);
  if (hits.length === 2) {
    console.log(`  ✓ R1 FECHADO — EQUALS apanha o valor dentro da lista multi-valor. Crossover por lista suportado.`);
  } else if (hits.length === 1) {
    console.log(`  ✗ PARAR — apareceu SÓ em "${hits[0]}". Ordem da lista: ${JSON.stringify(VALUES)} (o valor que casou é ${hits[0] === "star-wars" ? '"Star Wars"' : '"Mickey & Friends"'}).`);
    console.log(`    Provável: EQUALS casa só o 1.º elemento da lista. Repetir com --order reverse para confirmar.`);
  } else {
    console.log(`  ✗✗ PARAR E REPORTAR JÁ — não apareceu em NENHUMA. EQUALS não casa contra listas multi-valor.`);
    console.log(`    Bloqueia todo o modelo de crossover. Alternativas a comparar (sem implementar):`);
    console.log(`      A) OR: appliedDisjunctively:true, 1 regra PRODUCT_METAFIELD_DEFINITION por valor (validado no Basic, Tarefa 7).`);
    console.log(`      B) 1 metafield booleano por universo.`);
  }

  if (KEEP) {
    console.log(`\n--keep: produto ${id} deixado na loja.`);
  } else {
    const d = await client.graphql(DEL, { input: { id } });
    console.log(`\napagado ${id}: ${d.productDelete?.deletedProductId ? "✓" : "✗ " + JSON.stringify(d.productDelete?.userErrors)}`);
  }

  if (hits.length !== 2) process.exit(2);
}

main().catch((err) => { console.error(err?.stack || err?.message || err); process.exit(1); });
