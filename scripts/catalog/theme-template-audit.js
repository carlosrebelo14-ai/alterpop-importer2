#!/usr/bin/env node
/**
 * BRIEFING passos 1-3 · Tarefa 3 — auditoria dos ficheiros de template do TEMA ALVO
 * (o que recebe publicação, role MAIN — não o tema de desenvolvimento do MacBook).
 *
 * READ-ONLY. Não publica tema, não cria/edita ficheiros.
 *
 * 1. lista os temas (id, nome, role)
 * 2. no tema MAIN, lista templates/ e procura:
 *      templates/collection.universe-room.json
 *      templates/collection.line.json
 * 3. cruza com as coleções reais: templateSuffix de `star-wars` e `the-mandalorian`
 *
 * Correr na Fla:  node scripts/catalog/theme-template-audit.js
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const args = process.argv.slice(2);
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const THEMES = `
  query TA_Themes {
    themes(first: 25) { nodes { id name role createdAt updatedAt } }
  }
`;
const THEME_FILES = `
  query TA_Files($id: ID!, $filenames: [String!]) {
    theme(id: $id) {
      id name role
      files(first: 50, filenames: $filenames) {
        nodes { filename createdAt updatedAt }
      }
    }
  }
`;
const COLL = `
  query TA_Coll($h: String!) {
    collectionByHandle(handle: $h) { handle templateSuffix }
  }
`;

const WANT = [
  "templates/collection.universe-room.json",
  "templates/collection.line.json",
  "templates/collection.universe-room.liquid",
  "templates/collection.line.liquid",
];

async function restAssets(client, themeIdNum) {
  const url = `https://${client.store}/admin/api/2025-10/themes/${themeIdNum}/assets.json`;
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": client.accessToken } });
  if (!res.ok) throw new Error(`REST assets HTTP ${res.status}`);
  const body = await res.json();
  return (body.assets || []).map((a) => a.key);
}

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  console.log(`=== theme-template-audit (${SHOP}) ===\n`);

  const themes = (await client.graphql(THEMES)).themes?.nodes || [];
  console.log(`── temas na loja (${themes.length}) ──`);
  for (const t of themes) {
    console.log(`  ${String(t.role).padEnd(12)} ${t.name.padEnd(32)} ${t.id}   (updated ${t.updatedAt?.slice(0, 10)})`);
  }

  const main = themes.find((t) => t.role === "MAIN");
  if (!main) {
    console.log(`\n✗ nenhum tema com role MAIN — nada publicado. Parar.`);
    process.exit(1);
  }
  console.log(`\n── tema alvo: "${main.name}" (${main.role}, ${main.id}) ──`);

  let files = [];
  try {
    const d = await client.graphql(THEME_FILES, { id: main.id, filenames: WANT });
    files = (d.theme?.files?.nodes || []).map((n) => n.filename);
  } catch (err) {
    console.log(`  (theme.files GraphQL falhou: ${err.message} — a tentar REST)`);
  }
  if (!files.length) {
    try {
      const idNum = main.id.split("/").pop();
      const all = await restAssets(client, idNum);
      files = all.filter((k) => k.startsWith("templates/collection"));
      console.log(`  (via REST: ${files.length} templates/collection*)`);
    } catch (err) {
      console.log(`  (REST também falhou: ${err.message})`);
    }
  }

  const present = new Set(files);
  console.log(`\n── ficheiros de template ──`);
  console.log(`  ${"esperado".padEnd(46)} presente  tema`);
  for (const f of ["templates/collection.universe-room.json", "templates/collection.line.json"]) {
    const hit = present.has(f) || present.has(f.replace(".json", ".liquid"));
    console.log(`  ${f.padEnd(46)} ${hit ? "SIM ✓  " : "NÃO ✗  "}  ${hit ? main.name : "—"}`);
  }
  if (files.length) {
    console.log(`\n  (todos os templates/collection* vistos: ${files.join(", ")})`);
  }

  console.log(`\n── coleções reais vs templateSuffix ──`);
  for (const h of ["star-wars", "the-mandalorian"]) {
    const c = (await client.graphql(COLL, { h })).collectionByHandle;
    console.log(`  ${h.padEnd(16)} templateSuffix = ${c?.templateSuffix ? `"${c.templateSuffix}"` : "∅ (default)"}`);
  }

  console.log(`\n(read-only — nenhum tema publicado, nenhum ficheiro tocado.)`);
}

main().catch((err) => { console.error(err?.stack || err?.message || err); process.exit(1); });
