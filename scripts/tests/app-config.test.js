#!/usr/bin/env node
/* eslint-env node */
/**
 * check-app-config + workflow shopify-app-deploy. O shopify.app.toml tem de declarar os 3 webhooks
 * (app/uninstalled, app/scopes_update, orders/create) e todos os scopes da versão 12, mais read_themes;
 * um toml sem eles faria o deploy retirá-los da versão nova.
 * Uso: node scripts/tests/app-config.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compareConfig, readLocalConfig, parseToml } from "../maintenance/check-app-config.mjs";

const ROOT = process.cwd();
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "config/shopify-app-version-12.json"), "utf8"));
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}
/** Cópia do toml e das extensões num diretório temporário, com uma alteração. */
function variant(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-config-"));
  fs.copyFileSync(path.join(ROOT, "shopify.app.toml"), path.join(dir, "shopify.app.toml"));
  fs.cpSync(path.join(ROOT, "extensions"), path.join(dir, "extensions"), {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.includes(`${path.sep}dist`),
  });
  mutate(dir);
  return dir;
}
const edit = (dir, file, fn) => {
  const f = path.join(dir, file);
  fs.writeFileSync(f, fn(fs.readFileSync(f, "utf8")));
};

console.log("repositório real");
const real = readLocalConfig(ROOT);
check("o toml real reproduz a versão 12 e só acrescenta read_themes", () => {
  const { problems, rows } = compareConfig(baseline, real);
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.find((r) => r.name === "scopes").added, ["read_themes"]);
});
check("declara os 3 webhooks, api_version 2025-10, URIs com rota na app", () => {
  assert.deepEqual([...real.webhooks.topics].sort(), ["app/scopes_update", "app/uninstalled", "orders/create"]);
  assert.equal(real.webhooks.api_version, "2025-10");
  for (const uri of real.webhooks.uris) {
    const route = `app/routes/${uri.replace(/^\//, "").replace(/\//g, ".")}.jsx`;
    assert.ok(fs.existsSync(path.join(ROOT, route)), `sem rota ${route} para ${uri}`);
  }
});
check("extensões order-invoice e wishlist presentes, sem node_modules/dist em falta de código fonte", () => {
  assert.deepEqual([...real.extensions].sort(), ["order-invoice", "wishlist"]);
  assert.ok(fs.existsSync(path.join(ROOT, "extensions/order-invoice/src/OrderStatusBlock.jsx")));
  assert.ok(fs.existsSync(path.join(ROOT, "extensions/wishlist/src/WishlistPage.jsx")));
});
check("parseToml lê arrays multilinha e tabelas aninhadas", () => {
  const t = parseToml('a = 1\n[x]\nl = [\n "a",\n "b"\n]\n[[x.y]]\nk = "v"\n[[x.y]]\nk = "w" # c\n');
  assert.deepEqual(t.x.l, ["a", "b"]);
  assert.deepEqual(t.x.y.map((e) => e.k), ["v", "w"]);
});

console.log("o check falha quando o toml deixa de reproduzir a versão 12");
const cli = (dir) => spawnSync(process.execPath, [path.join(ROOT, "scripts/maintenance/check-app-config.mjs"), "--root", dir, "--baseline", path.join(ROOT, "config/shopify-app-version-12.json")], { encoding: "utf8" });
check("sem o webhook orders/create → falha", () => {
  const dir = variant((d) => edit(d, "shopify.app.toml", (s) => s.replace(/\n {2}\[\[webhooks\.subscriptions\]\]\n {2}uri = "\/webhooks\/orders\/create"\n {2}topics = \[ "orders\/create" \]\n/, "\n")));
  const r = cli(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /webhooks \(tópicos\): falta "orders\/create"/);
});
check("sem a secção de webhooks → falha nos 3", () => {
  const dir = variant((d) => edit(d, "shopify.app.toml", (s) => s.replace(/\[webhooks\][\s\S]*?(?=\[access_scopes\])/, "")));
  const r = cli(dir);
  assert.equal(r.status, 1);
  for (const t of ["app/uninstalled", "app/scopes_update", "orders/create"]) assert.ok(r.stderr.includes(`falta "${t}"`), t);
});
check("sem read_themes → falha; com scope extra → falha", () => {
  let r = cli(variant((d) => edit(d, "shopify.app.toml", (s) => s.replace(",read_themes", ""))));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /falta o acrescento esperado "read_themes"/);
  r = cli(variant((d) => edit(d, "shopify.app.toml", (s) => s.replace("read_themes", "read_themes,write_themes"))));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /acrescento inesperado "write_themes"/);
});
check("sem uma extensão ou sem um scope da versão 12 → falha", () => {
  let r = cli(variant((d) => fs.rmSync(path.join(d, "extensions/wishlist/shopify.extension.toml"))));
  assert.match(r.stderr, /extensões: falta "wishlist"/);
  r = cli(variant((d) => edit(d, "shopify.app.toml", (s) => s.replace("write_publications", ""))));
  assert.equal(r.status, 1);
});
check("api_version dos webhooks diferente → falha", () => {
  const r = cli(variant((d) => edit(d, "shopify.app.toml", (s) => s.replace('api_version = "2025-10"', 'api_version = "2026-01"'))));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /api_version/);
});

console.log("workflow shopify-app-deploy.yml");
const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/shopify-app-deploy.yml"), "utf8");
const code = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
check("só workflow_dispatch, só main, token só por secrets.SHOPIFY_APP_AUTOMATION_TOKEN", () => {
  assert.match(code, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(code, /^\s+(push|pull_request|schedule):/m);
  assert.match(code, /if: github\.ref == 'refs\/heads\/main'/);
  assert.equal([...code.matchAll(/secrets\./g)].length, 1);
  assert.match(code, /SHOPIFY_APP_AUTOMATION_TOKEN: \$\{\{ secrets\.SHOPIFY_APP_AUTOMATION_TOKEN \}\}/);
});
check("nunca --allow-deletes nem --force; o check corre antes de qualquer deploy", () => {
  assert.doesNotMatch(code, /--allow-deletes|--force|\s-f\s/);
  assert.ok(code.indexOf("check-app-config.mjs") < code.indexOf("shopify app deploy"));
});
check("ação por omissão é diff; create_version usa --no-release; release só com a escolha release", () => {
  assert.match(code, /type: choice\n\s+default: diff\n\s+options:\n\s+- diff\n\s+- create_version\n\s+- release/);
  const create = code.slice(code.indexOf("Criar versão"), code.indexOf("Lançar versão"));
  assert.match(create, /if: env\.ACTION == 'create_version'/);
  assert.match(create, /--no-release/);
  const rel = code.slice(code.indexOf("Lançar versão"));
  assert.match(rel, /if: env\.ACTION == 'release'/);
  assert.doesNotMatch(rel, /--no-release/);
  assert.doesNotMatch(code, /\$\{\{\s*inputs\.(?!action)/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\napp-config: todos os casos passaram");
