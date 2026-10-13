#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 32 — guarda do tema (read_themes), contra uma loja Shopify falsa (sem rede):
 *   - template em falta bloqueia o lote; definição sem acesso storefront bloqueia;
 *   - mudança de settings/secções/filtros dá aviso, nunca bloqueia;
 *   - scope em falta é um estado próprio (não "tema inválido");
 *   - o snapshot só se reconstrói quando o `updatedAt` do tema muda (ou com refresh);
 *   - THEME_GUARD desligada não consulta a loja; erro técnico recusa;
 *   - NENHUMA operação escreve no tema: só queries, nenhuma mutation, nenhum PUT/POST a assets.
 * Uso: node scripts/tests/theme-contract.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cwd = process.cwd();
process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "theme-contract-unused.sqlite")}`;
delete process.env.THEME_GUARD;

const pure = await import(path.join(cwd, "lib/importer/shopify/themeContract.js"));
const svc = await import(path.join(cwd, "lib/importer/shopify/themeContract.server.js"));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ") || err.message}`);
  }
}

const SHOP = `theme-test-${process.pid}.myshopify.com`;
const snapshotFile = path.join(cwd, "data", "theme-contract", `${SHOP}.json`);
const cleanup = () => fs.rmSync(snapshotFile, { force: true });
cleanup();

const collectionTemplate = JSON.stringify({ sections: { main: { type: "main-collection" }, filters: { type: "collection-filters" } }, order: ["main", "filters"] });
const productTemplate = JSON.stringify({ sections: { main: { type: "main-product" } }, order: ["main"] });
const baseFiles = () => ({
  "templates/collection.universe-room.json": collectionTemplate,
  "templates/collection.line.json": collectionTemplate,
  "templates/product.json": productTemplate,
  "config/settings_data.json": JSON.stringify({ current: {} }),
  "sections/main-collection.liquid": "{% render 'grid' %}",
  "sections/collection-filters.liquid": "{% for filter in collection.filters %}{% endfor %}",
  "sections/main-product.liquid": "<div></div>",
});
const declaredDefs = () =>
  pure.declaredStorefrontDefinitions().map((d) => ({ namespace: d.namespace, key: d.key, ownerType: d.ownerType, access: { storefront: "PUBLIC_READ" } }));

/** Loja falsa: só responde a queries; qualquer mutation falha. */
function makeShop(over = {}) {
  const state = {
    scopes: ["read_products", "read_themes"],
    theme: { id: "gid://shopify/OnlineStoreTheme/1", name: "Alterpop", role: "MAIN", updatedAt: "2026-10-10T10:00:00Z" },
    files: baseFiles(),
    definitions: declaredDefs(),
    failThemes: null,
    ...over,
  };
  const calls = [];
  const client = {
    async graphql(query, vars = {}) {
      const name = (query.match(/(?:query|mutation)\s+(\w+)/) || [])[1];
      calls.push({ name, vars, isMutation: /^\s*mutation\b/.test(query) });
      if (/^\s*mutation\b/.test(query)) throw new Error("MUTATION NÃO PERMITIDA: a guarda do tema é só de leitura");
      switch (name) {
        case "ThemeContractScopes":
          return { currentAppInstallation: { accessScopes: state.scopes.map((handle) => ({ handle })) } };
        case "ThemeContractThemes":
          if (state.failThemes) throw new Error(state.failThemes);
          return { themes: { nodes: state.theme ? [state.theme, { id: "gid://shopify/OnlineStoreTheme/2", name: "Dev", role: "UNPUBLISHED", updatedAt: "2026-01-01T00:00:00Z" }] : [] } };
        case "ThemeContractFiles": {
          const wanted = new Set(vars.filenames || []);
          return {
            theme: {
              id: vars.id,
              files: {
                nodes: Object.entries(state.files)
                  .filter(([f]) => wanted.has(f))
                  .map(([filename, content]) => ({ filename, checksumMd5: "x", size: content.length, updatedAt: state.theme.updatedAt, body: { content } })),
              },
            },
          };
        }
        case "ThemeContractDefinitions":
          return {
            metafieldDefinitions: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: state.definitions.filter((d) => d.ownerType === vars.ownerType),
            },
          };
        case "CondGuard":
          return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
        default:
          throw new Error(`consulta inesperada: ${name}`);
      }
    },
  };
  return { client, state, calls, count: (n) => calls.filter((c) => c.name === n).length };
}

console.log("contrato válido");
await check("tema completo: ok, sem bloqueios nem avisos", async () => {
  cleanup();
  const s = makeShop();
  const r = await svc.getThemeContractStatus(s.client, SHOP);
  assert.equal(r.status, "ok", JSON.stringify([r.blocking, r.warnings]));
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.rebuilt, true);
  assert.equal(r.themeName, "Alterpop");
});
await check("a variante .liquid dos templates também serve", async () => {
  cleanup();
  const files = baseFiles();
  delete files["templates/collection.line.json"];
  files["templates/collection.line.liquid"] = "{{ collection.title }}";
  const r = await svc.getThemeContractStatus(makeShop({ files }).client, SHOP);
  assert.equal(r.status, "ok", JSON.stringify([r.blocking, r.warnings]));
});
await check("os ficheiros pedidos derivam dos sufixos declarados (universe-room, line, produto, settings)", () => {
  const f = pure.contractFilenames();
  for (const x of ["templates/collection.universe-room.json", "templates/collection.line.json", "templates/product.json", "config/settings_data.json"]) assert.ok(f.includes(x), x);
});

console.log("bloqueios");
await check("template de coleção em falta bloqueia o lote", async () => {
  cleanup();
  const files = baseFiles();
  delete files["templates/collection.line.json"];
  const s = makeShop({ files });
  const r = await svc.getThemeContractStatus(s.client, SHOP);
  assert.equal(r.status, "blocked");
  assert.ok(r.blocking.some((b) => b.code === "TEMPLATE_MISSING" && b.file === "templates/collection.line.json"));
  await assert.rejects(() => svc.assertThemeContractValid(s.client, SHOP, { enforce: true }), (e) => e.code === "THEME_CONTRACT_INVALID" && /collection\.line/.test(e.message) && e.status === 409);
});
await check("template de produto em falta bloqueia", async () => {
  cleanup();
  const files = baseFiles();
  delete files["templates/product.json"];
  const r = await svc.getThemeContractStatus(makeShop({ files }).client, SHOP);
  assert.equal(r.status, "blocked");
  assert.ok(r.blocking.some((b) => b.code === "PRODUCT_TEMPLATE_MISSING"));
});
await check("definição declarada PUBLIC_READ sem acesso storefront (ou em falta) bloqueia", async () => {
  cleanup();
  const definitions = declaredDefs().filter((d) => d.key !== "first_published_at").map((d) => (d.key === "format" ? { ...d, access: { storefront: "NONE" } } : d));
  const r = await svc.getThemeContractStatus(makeShop({ definitions }).client, SHOP);
  assert.equal(r.status, "blocked");
  assert.ok(r.blocking.some((b) => b.code === "DEFINITION_STOREFRONT_ACCESS" && /format/.test(b.key)));
  assert.ok(r.blocking.some((b) => b.code === "DEFINITION_MISSING" && /first_published_at/.test(b.key)));
});
await check("as definições declaradas NONE (franchise, line, manufacturer_line) não entram no contrato", () => {
  const keys = pure.declaredStorefrontDefinitions().map((d) => d.key);
  for (const k of ["franchise", "line", "manufacturer_line"]) assert.ok(!keys.includes(k), k);
  assert.deepEqual(keys.sort(), ["first_published_at", "format", "hero_image", "is_new_arrival"]);
});
await check("sem tema MAIN bloqueia", async () => {
  cleanup();
  const r = await svc.getThemeContractStatus(makeShop({ theme: null }).client, SHOP);
  assert.equal(r.status, "blocked");
  assert.equal(r.blocking[0].code, "NO_MAIN_THEME");
});
await check("handles/regras de Universe e Line divergentes bloqueiam (guarda existente), só com includeFranchise", async () => {
  cleanup();
  const s = makeShop();
  const without = await svc.getThemeContractStatus(s.client, SHOP);
  assert.equal(s.count("CondGuard"), 0, "o lote corre a guarda de franquias à parte");
  assert.equal(without.status, "ok");
  const withGuard = await svc.getThemeContractStatus(s.client, SHOP, { includeFranchise: true });
  assert.equal(withGuard.status, "blocked");
  assert.ok(withGuard.blocking.some((b) => b.code === "FRANCHISE_GUARD"));
});

console.log("avisos (nunca bloqueiam)");
await check("mudança de settings (settings_data.json ilegível/ausente) dá aviso sem bloquear", async () => {
  cleanup();
  const files = baseFiles();
  files["config/settings_data.json"] = "{ não é json";
  const s = makeShop({ files });
  const r = await svc.getThemeContractStatus(s.client, SHOP);
  assert.equal(r.status, "warn");
  assert.deepEqual(r.blocking, []);
  assert.ok(r.warnings.some((w) => w.code === "SETTINGS_DATA_INVALID"));
  const passed = await svc.assertThemeContractValid(s.client, SHOP, { enforce: true });
  assert.equal(passed.status, "warn", "o aviso não recusa o lote");
  delete files["config/settings_data.json"];
  cleanup();
  const r2 = await svc.getThemeContractStatus(makeShop({ files }).client, SHOP);
  assert.ok(r2.warnings.some((w) => w.code === "SETTINGS_DATA_MISSING"));
  assert.deepEqual(r2.blocking, []);
});
await check("secção referenciada em falta e template sem filtros dão aviso", async () => {
  cleanup();
  const files = baseFiles();
  delete files["sections/collection-filters.liquid"];
  const r = await svc.getThemeContractStatus(makeShop({ files }).client, SHOP);
  assert.equal(r.status, "warn");
  assert.ok(r.warnings.some((w) => w.code === "SECTION_MISSING" && w.key === "collection-filters"));
  assert.ok(r.warnings.some((w) => w.code === "NO_FILTER_SECTION"));
  assert.deepEqual(r.blocking, []);
});
await check("template JSON inválido dá aviso", async () => {
  cleanup();
  const files = baseFiles();
  files["templates/collection.line.json"] = "{ nope";
  const r = await svc.getThemeContractStatus(makeShop({ files }).client, SHOP);
  assert.ok(r.warnings.some((w) => w.code === "TEMPLATE_JSON_INVALID"));
  assert.deepEqual(r.blocking, []);
});

console.log("scope");
await check("sem read_themes: estado scope_missing (não 'tema inválido'), nem toca no tema", async () => {
  cleanup();
  const s = makeShop({ scopes: ["read_products"] });
  const r = await svc.getThemeContractStatus(s.client, SHOP);
  assert.equal(r.status, "scope_missing");
  assert.deepEqual(r.missingScopes, ["read_themes"]);
  assert.equal(s.count("ThemeContractThemes"), 0);
  await assert.rejects(() => svc.assertThemeContractValid(s.client, SHOP, { enforce: true }), (e) => e.code === "THEME_SCOPE_MISSING");
});
await check("erro de acesso devolvido pela Shopify também vira scope_missing", async () => {
  cleanup();
  const s = makeShop({ failThemes: "Access denied for themes field. Required access: `read_themes` access scope." });
  const r = await svc.getThemeContractStatus(s.client, SHOP);
  assert.equal(r.status, "scope_missing");
});

console.log("snapshot");
await check("só reconstrói quando o updatedAt do tema muda; refresh força", async () => {
  cleanup();
  const s = makeShop();
  const a = await svc.getThemeContractStatus(s.client, SHOP);
  assert.equal(a.rebuilt, true);
  assert.equal(s.count("ThemeContractFiles"), 2, "templates + secções");
  const b = await svc.getThemeContractStatus(s.client, SHOP);
  assert.equal(b.rebuilt, false);
  assert.equal(s.count("ThemeContractFiles"), 2, "snapshot reaproveitado");
  s.state.theme = { ...s.state.theme, updatedAt: "2026-10-11T09:00:00Z" };
  const c = await svc.getThemeContractStatus(s.client, SHOP);
  assert.equal(c.rebuilt, true);
  assert.equal(c.status, "ok", "mudança de updatedAt sozinha não bloqueia");
  assert.equal(s.count("ThemeContractFiles"), 4);
  const d = await svc.refreshThemeContract(s.client, SHOP);
  assert.equal(d.rebuilt, true);
  assert.equal(s.count("ThemeContractFiles"), 6);
});
await check("a mudança do tema é reavaliada: template removido passa a bloquear", async () => {
  cleanup();
  const s = makeShop();
  assert.equal((await svc.getThemeContractStatus(s.client, SHOP)).status, "ok");
  delete s.state.files["templates/collection.universe-room.json"];
  s.state.theme = { ...s.state.theme, updatedAt: "2026-10-12T09:00:00Z" };
  assert.equal((await svc.getThemeContractStatus(s.client, SHOP)).status, "blocked");
});
await check("o estado guardado serve o painel sem rede (themeCompatibility)", async () => {
  cleanup();
  const s = makeShop();
  assert.equal((await svc.readStoredThemeStatus(SHOP)).status, "unknown");
  await svc.getThemeContractStatus(s.client, SHOP);
  const stored = await svc.readStoredThemeStatus(SHOP);
  assert.equal(stored.status, "ok");
  assert.equal(stored.themeName, "Alterpop");
  assert.ok(stored.checkedAt);
  fs.writeFileSync(snapshotFile, "{ lixo");
  assert.equal((await svc.readStoredThemeStatus(SHOP)).status, "unknown", "snapshot ilegível não derruba o painel");
});

console.log("portão do lote");
await check("THEME_GUARD desligada: não consulta a loja", async () => {
  const s = makeShop();
  assert.equal(await svc.assertThemeContractValid(s.client, SHOP), null);
  assert.equal(s.calls.length, 0);
});
await check("THEME_GUARD=ON liga o portão; erro técnico de leitura recusa", async () => {
  cleanup();
  process.env.THEME_GUARD = "ON";
  try {
    assert.equal(pure.isThemeGuardEnforced(), true);
    const s = makeShop({ failThemes: "Shopify HTTP 502" });
    await assert.rejects(() => svc.assertThemeContractValid(s.client, SHOP), (e) => e.code === "THEME_CONTRACT_UNAVAILABLE" && e.status === 502);
    const ok = makeShop();
    assert.equal((await svc.assertThemeContractValid(ok.client, SHOP)).status, "ok");
  } finally {
    delete process.env.THEME_GUARD;
  }
});

console.log("só leitura");
await check("nenhuma operação do fluxo emite uma mutation", async () => {
  cleanup();
  const s = makeShop();
  await svc.getThemeContractStatus(s.client, SHOP, { includeFranchise: true });
  await svc.refreshThemeContract(s.client, SHOP);
  await svc.assertThemeContractValid(s.client, SHOP, { enforce: true });
  assert.equal(s.calls.filter((c) => c.isMutation).length, 0);
});
await check("o código do tema não contém escritas (mutations, themeFiles*, REST de assets, PUT/DELETE)", () => {
  const files = [
    "lib/importer/shopify/themeContract.js",
    "lib/importer/shopify/themeContract.server.js",
    "app/routes/api.theme-contract.status.jsx",
    "app/routes/api.theme-contract.refresh.jsx",
    "scripts/catalog/theme-template-audit.js",
  ];
  const forbidden = /\bmutation\b|themeFiles(Upsert|Copy|Delete)|themeCreate\b|themeUpdate\b|themePublish\b|themeDelete\b|assets\.json|method:\s*["'](PUT|POST|DELETE|PATCH)["']|write_themes/;
  for (const f of files) {
    const code = fs
      .readFileSync(path.join(cwd, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!forbidden.test(code), `${f} contém uma operação de escrita`);
  }
});
await check("a app pede read_themes e nunca write_themes", () => {
  for (const f of ["shopify.app.toml", "app/shopify.server.js", ".env.example"]) {
    const src = fs.readFileSync(path.join(cwd, f), "utf8");
    assert.ok(!/write_themes/.test(src), `${f} pede write_themes`);
  }
  assert.match(fs.readFileSync(path.join(cwd, "shopify.app.toml"), "utf8"), /scopes = "[^"]*\bread_themes\b/);
  assert.match(fs.readFileSync(path.join(cwd, "app/shopify.server.js"), "utf8"), /read_themes/);
});

console.log("ligação ao lote");
await check("o motor de sync corre a guarda depois da de franquias; a rota pré-verifica antes de iniciar o job", () => {
  const eng = fs.readFileSync(path.join(cwd, "lib/importer/shopify/shopifyApprovedSync.server.js"), "utf8");
  assert.ok(eng.indexOf("assertThemeContractValid(client") > eng.indexOf("assertFranchiseConditionsAligned(client)"));
  assert.ok(eng.indexOf("assertThemeContractValid(client") < eng.indexOf("const BATCH_SIZE") || eng.indexOf("assertThemeContractValid(client") < eng.indexOf("await sleep("));
  const route = fs.readFileSync(path.join(cwd, "app/routes/api.shopify-sync.jsx"), "utf8");
  assert.ok(route.indexOf("assertThemeContractValid(") < route.indexOf("await initShopifySyncJob("));
  assert.match(route, /THEME_CONTRACT_INVALID|err\.code/);
});

cleanup();
if (failures) {
  console.error(`\n${failures} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
