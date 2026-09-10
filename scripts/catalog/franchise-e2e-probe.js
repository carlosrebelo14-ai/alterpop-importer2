#!/usr/bin/env node
/**
 * ENTREGA 2 · Tarefa 9 — teste end-to-end com produtos DESCARTÁVEIS.
 *
 * Não é seleção de catálogo. Verifica a infraestrutura:
 *   - resolveFranchise decide franchise (+ line) para cada caso
 *   - o mesmo caminho de metafields do publish (alterpop.franchise / alterpop.line) escreve
 *   - as salas Universe/Line povoam-se pela regra EQUALS
 *   - um produto Mandalorian aparece EM SIMULTÂNEO em `star-wars` e `the-mandalorian`
 *   - um título Sanrio não recebe franquia nenhuma (órfão, correto)
 *
 * Cria ~6 produtos, escreve, faz polling da pertença às coleções (a Shopify avalia as
 * regras de forma assíncrona), reporta produto a produto, e apaga tudo no fim.
 *
 * ⚠️ Pré-requisitos (falha cedo se faltarem):
 *   - definição alterpop.line criada (ALTERPOP_LINE_DEFINITION_GID != null)
 *   - coleção the-mandalorian já com regra alterpop.line (mandalorian-collection-to-line.js)
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/franchise-e2e-probe.js
 *   node scripts/catalog/franchise-e2e-probe.js --keep       # não apaga
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { resolveFranchise } from "../../lib/importer/catalog/franchiseResolver.server.js";
import {
  ALTERPOP_LINE_DEFINITION_GID,
} from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

/** Casos de teste — { title, franchiseRefs } → o resolver decide o resto. */
const CASES = [
  { title: "zzz-e2e Star Wars Darth Vader helmet replica", franchiseRefs: ["Star Wars"] },
  { title: "zzz-e2e Star Wars The Mandalorian Grogu figure", franchiseRefs: ["Star Wars"] },
  { title: "zzz-e2e Grogu plush toy 25cm", franchiseRefs: [] },
  { title: "zzz-e2e Harry Potter Hogwarts express model", franchiseRefs: ["Harry Potter"] },
  { title: "zzz-e2e One Piece Luffy Gear 5 figure", franchiseRefs: ["Onepiece"] },
  { title: "zzz-e2e Hello Kitty classic plush 30cm", franchiseRefs: ["Hello Kitty"] },
];

const PRODUCT_CREATE = `
  mutation E2ECreate($input: ProductInput!) {
    productCreate(input: $input) { product { id title } userErrors { field message } }
  }
`;
const METAFIELDS_SET = `
  mutation E2EMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { key namespace value } userErrors { field message } }
  }
`;
const PRODUCT_DELETE = `
  mutation E2EDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) { deletedProductId userErrors { field message } }
  }
`;
const COLLECTION_MEMBERS = `
  query E2EColl($handle: String!) {
    collectionByHandle(handle: $handle) {
      id handle templateSuffix
      ruleSet { rules { column relation condition } }
      products(first: 50) { nodes { id title } }
    }
  }
`;

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function setMetafields(client, productId, franchise, line) {
  const mfs = [];
  if (franchise) {
    mfs.push({ ownerId: productId, namespace: "alterpop", key: "franchise", type: "list.single_line_text_field", value: JSON.stringify([franchise]) });
  }
  if (line) {
    mfs.push({ ownerId: productId, namespace: "alterpop", key: "line", type: "list.single_line_text_field", value: JSON.stringify([line]) });
  }
  if (!mfs.length) return [];
  const res = await client.graphql(METAFIELDS_SET, { metafields: mfs });
  const errs = res.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return res.metafieldsSet?.metafields || [];
}

async function main() {
  if (!ALTERPOP_LINE_DEFINITION_GID) {
    console.error("ALTERPOP_LINE_DEFINITION_GID nulo — corre line-metafield-definition.js primeiro.");
    process.exit(1);
  }
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const stamp = Date.now();

  console.log(`=== franchise-e2e-probe (${SHOP}) ===\n`);

  // 1. resolver + criar + escrever
  const made = [];
  for (const c of CASES) {
    const res = resolveFranchise({ franchiseRefs: c.franchiseRefs, title: c.title });
    const cr = await client.graphql(PRODUCT_CREATE, {
      input: { title: `${c.title} [${stamp}]`, status: "DRAFT" },
    });
    const errs = cr.productCreate?.userErrors || [];
    if (errs.length || !cr.productCreate?.product?.id) {
      console.log(`✗ create falhou: ${c.title} — ${errs.map((e) => e.message).join("; ")}`);
      continue;
    }
    const id = cr.productCreate.product.id;
    let wrote = [];
    try {
      wrote = await setMetafields(client, id, res.franchise, res.line);
    } catch (err) {
      console.log(`✗ metafields falhou: ${c.title} — ${err.message}`);
    }
    made.push({ ...c, id, resolved: res, wrote });
    console.log(
      `• ${c.title}\n    → franchise=${res.franchise ?? "∅"}  line=${res.line ?? "∅"}  (layer ${res.layer})  metafields escritos: ${wrote.map((w) => w.key).join(",") || "nenhum"}`
    );
  }

  // 2. polling da pertença às coleções
  const handlesToCheck = ["star-wars", "the-mandalorian", "harry-potter", "one-piece", "hello-kitty"];
  console.log(`\n── a aguardar avaliação das regras (polling até 90s) ──`);
  let snapshot = {};
  for (let attempt = 1; attempt <= 9; attempt++) {
    await sleep(10);
    snapshot = {};
    for (const h of handlesToCheck) {
      const d = await client.graphql(COLLECTION_MEMBERS, { handle: h });
      const col = d.collectionByHandle;
      if (!col) { snapshot[h] = null; continue; }
      snapshot[h] = {
        rule: col.ruleSet?.rules?.[0] ? `${col.ruleSet.rules[0].column} ${col.ruleSet.rules[0].relation} ${JSON.stringify(col.ruleSet.rules[0].condition)}` : "MANUAL",
        template: col.templateSuffix || "∅",
        members: new Set((col.products?.nodes || []).map((n) => n.id)),
      };
    }
    const swHit = made.find((m) => m.resolved.franchise === "Star Wars" && m.resolved.line === "The Mandalorian");
    if (swHit && snapshot["star-wars"]?.members.has(swHit.id) && snapshot["the-mandalorian"]?.members.has(swHit.id)) {
      console.log(`  (regras avaliadas ao fim de ~${attempt * 10}s)`);
      break;
    }
  }

  // 3. relatório produto a produto
  console.log(`\n── resultado por produto ──`);
  let pass = 0, fail = 0;
  for (const m of made) {
    const inSW = snapshot["star-wars"]?.members.has(m.id) || false;
    const inManda = snapshot["the-mandalorian"]?.members.has(m.id) || false;
    const inHP = snapshot["harry-potter"]?.members.has(m.id) || false;
    const inOP = snapshot["one-piece"]?.members.has(m.id) || false;
    const inHK = snapshot["hello-kitty"]?.members.has(m.id) || false;

    let expect, got, ok;
    if (m.resolved.line === "The Mandalorian") {
      expect = "star-wars + the-mandalorian";
      got = [inSW && "star-wars", inManda && "the-mandalorian"].filter(Boolean).join(" + ") || "nenhuma";
      ok = inSW && inManda;
    } else if (m.resolved.franchise === "Star Wars") {
      expect = "star-wars (só)";
      got = [inSW && "star-wars", inManda && "the-mandalorian"].filter(Boolean).join(" + ") || "nenhuma";
      ok = inSW && !inManda;
    } else if (m.resolved.franchise === "Harry Potter") {
      expect = "harry-potter"; got = inHP ? "harry-potter" : "nenhuma"; ok = inHP;
    } else if (m.resolved.franchise === "One Piece") {
      expect = "one-piece"; got = inOP ? "one-piece" : "nenhuma"; ok = inOP;
    } else if (!m.resolved.franchise) {
      expect = "nenhuma (órfão)"; got = [inSW && "sw", inHK && "hk", inManda && "manda"].filter(Boolean).join("+") || "nenhuma"; ok = !inSW && !inManda && !inHK;
    } else {
      expect = `franchise ${m.resolved.franchise}`; got = "(não verificado)"; ok = true;
    }
    console.log(`  ${ok ? "✓" : "✗"} "${m.title}"`);
    console.log(`      resolvido: franchise=${m.resolved.franchise ?? "∅"} line=${m.resolved.line ?? "∅"}`);
    console.log(`      esperado : ${expect}`);
    console.log(`      obtido   : ${got}`);
    ok ? pass++ : fail++;
  }

  console.log(`\n── regras das coleções verificadas ──`);
  for (const h of handlesToCheck) {
    if (snapshot[h]) console.log(`  ${h.padEnd(16)} ${snapshot[h].rule}   tpl=${snapshot[h].template}`);
    else console.log(`  ${h.padEnd(16)} (não existe)`);
  }

  console.log(`\n${pass} pass · ${fail} fail`);

  // 4. limpar
  if (KEEP) {
    console.log(`\n--keep: ${made.length} produtos-teste na loja ([${stamp}]).`);
  } else {
    let del = 0;
    for (const m of made) {
      const r = await client.graphql(PRODUCT_DELETE, { input: { id: m.id } });
      if (r.productDelete?.deletedProductId) del++;
      await sleep(0.1);
    }
    console.log(`\napagados ${del}/${made.length} produtos-teste.`);
  }

  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
