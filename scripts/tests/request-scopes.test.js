#!/usr/bin/env node
/* eslint-env node */
/**
 * Pedido de scopes fora do iframe (app/utils/requestScopes.server.js), com a biblioteca
 * @shopify/shopify-app-react-router a sério (sessão em memória, id_token assinado, sem rede):
 *   - documento embebido (iframe do Admin) → página do App Bridge com window.open(url, "_top"),
 *     nunca um 401 sem corpo;
 *   - fetch com session token → 401 com o header de reautorização (o App Bridge segue-o);
 *   - scopes já concedidos → 302 para /app com shop/host/embedded/id_token preservados;
 *   - erro que não é de scopes → relançado intacto.
 * Uso: node scripts/tests/request-scopes.test.js
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";

process.env.SHOPIFY_APP_URL ||= "https://alterpop-importer-app.fly.dev";
const cwd = process.cwd();
const { shopifyApp, AppDistribution, ApiVersion } = await import("@shopify/shopify-app-react-router/server");
await import("@shopify/shopify-app-react-router/adapters/node");
const { Session } = await import("@shopify/shopify-api");
const { requestScopesOutOfFrame, REAUTH_URL_HEADER } = await import(path.join(cwd, "app/utils/requestScopes.server.js"));

const API_KEY = "test-api-key";
const SECRET = "test-api-secret";
const SHOP = "loja-teste.myshopify.com";
const APP = process.env.SHOPIFY_APP_URL;

class MemoryStorage {
  sessions = new Map();
  async storeSession(s) { this.sessions.set(s.id, s); return true; }
  async loadSession(id) { return this.sessions.get(id); }
  async deleteSession(id) { return this.sessions.delete(id); }
  async deleteSessions(ids) { ids.forEach((i) => this.sessions.delete(i)); return true; }
  async findSessionsByShop(shop) { return [...this.sessions.values()].filter((s) => s.shop === shop); }
}
const storage = new MemoryStorage();
await storage.storeSession(
  new Session({
    id: `offline_${SHOP}`,
    shop: SHOP,
    state: "state",
    isOnline: false,
    accessToken: "shpat_test",
    scope: "read_products,read_themes",
    expires: new Date(Date.now() + 3600e3),
    refreshToken: "refresh",
    refreshTokenExpires: new Date(Date.now() + 86400e3),
  })
);
const shopify = shopifyApp({
  apiKey: API_KEY,
  apiSecretKey: SECRET,
  apiVersion: ApiVersion.October25,
  scopes: ["read_products", "read_themes"],
  appUrl: APP,
  authPathPrefix: "/auth",
  sessionStorage: storage,
  distribution: AppDistribution.AppStore,
  future: { expiringOfflineAccessTokens: true },
});

function idToken() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({
    iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: API_KEY, sub: "1",
    exp: now + 60, nbf: now - 5, iat: now, jti: crypto.randomUUID(), sid: "sid-1",
  });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.stack?.split("\n").slice(0, 4).join("\n      ") || err.message}`);
  }
}

const INSTALL = `https://${SHOP}/admin/oauth/install?client_id=${API_KEY}&scope=read_products%2Cread_themes&optional_scopes=read_themes`;
/** `scopes.request` falso que faz exatamente o que a biblioteca faz: lança 401 + header. */
const needsGrant = {
  request: async () => {
    throw new Response(undefined, { status: 401, statusText: "Unauthorized", headers: { [REAUTH_URL_HEADER]: INSTALL } });
  },
};
const alreadyGranted = { request: async () => {} };

async function documentRequest() {
  const url = `${APP}/api/shopify/grant-themes-scope?embedded=1&shop=${SHOP}&host=${Buffer.from(`${SHOP}/admin`).toString("base64url")}&id_token=${idToken()}`;
  try {
    return await shopify.authenticate.admin(new Request(url));
  } catch (thrown) {
    if (thrown instanceof Response) throw new Error(`authenticate.admin devolveu ${thrown.status} ${thrown.headers.get("location") || ""} ${await thrown.text()}`);
    throw thrown;
  }
}
async function fetchRequest() {
  const url = `${APP}/api/shopify/grant-themes-scope?shop=${SHOP}`;
  return shopify.authenticate.admin(new Request(url, { headers: { Authorization: `Bearer ${idToken()}` } }));
}
async function outcome(fn) {
  try {
    return { returned: await fn() };
  } catch (thrown) {
    return { thrown };
  }
}

console.log("a biblioteca falha como descrito (prova do defeito)");
await check("scopes.request() sem o helper dá 401 sem corpo: ecrã em branco num documento", async () => {
  const r = new Response(undefined, { status: 401, headers: { [REAUTH_URL_HEADER]: INSTALL } });
  assert.equal(r.status, 401);
  assert.equal(await r.text(), "");
});

await check("o botão antigo (window.open _top sem shop/host) dava uma página App Bridge sem redirect: em branco", async () => {
  const { thrown } = await outcome(() => shopify.authenticate.admin(new Request(`${APP}/api/shopify/grant-themes-scope`)));
  assert.ok(thrown instanceof Response);
  const html = await thrown.text();
  assert.match(html, /app-bridge\.js/);
  assert.doesNotMatch(html, /window\.open/);
});

console.log("requestScopesOutOfFrame");
await check("documento embebido (iframe do Admin) → página App Bridge com window.open(url, '_top')", async () => {
  const { redirect } = await documentRequest();
  const { thrown, returned } = await outcome(() => requestScopesOutOfFrame({ scopes: needsGrant, redirect, requested: ["read_themes"] }));
  const res = thrown ?? returned;
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200, "não pode ser o 401 vazio");
  const html = await res.text();
  assert.ok(html.length > 50, "corpo vazio");
  assert.match(html, /<script data-api-key="test-api-key" src="https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js"><\/script>/);
  assert.ok(html.includes(`window.open(${JSON.stringify(INSTALL)}, "_top")`), html);
  assert.match(res.headers.get("content-security-policy") || "", /frame-ancestors/);
});
await check("fetch com session token → 401 com o header de reautorização (App Bridge segue)", async () => {
  const { redirect } = await fetchRequest();
  const { thrown } = await outcome(() => requestScopesOutOfFrame({ scopes: needsGrant, redirect, requested: ["read_themes"] }));
  assert.ok(thrown instanceof Response);
  assert.equal(thrown.status, 401);
  assert.equal(thrown.headers.get(REAUTH_URL_HEADER), INSTALL);
});
await check("já concedido → 302 para /app com shop, host, embedded e id_token preservados", async () => {
  const { redirect } = await documentRequest();
  const { thrown, returned } = await outcome(() => requestScopesOutOfFrame({ scopes: alreadyGranted, redirect, requested: ["read_themes"] }));
  const res = thrown ?? returned;
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location"), APP);
  assert.equal(loc.pathname, "/app");
  for (const k of ["embedded", "shop", "host", "id_token"]) assert.ok(loc.searchParams.has(k), `perdeu ${k}`);
});
await check("erro que não é de scopes é relançado intacto", async () => {
  const { redirect } = await documentRequest();
  const boom = new Error("graphql caiu");
  const failing = { request: async () => { throw boom; } };
  const { thrown } = await outcome(() => requestScopesOutOfFrame({ scopes: failing, redirect, requested: ["read_themes"] }));
  assert.equal(thrown, boom);
  const other = new Response("x", { status: 500 });
  const { thrown: t2 } = await outcome(() => requestScopesOutOfFrame({ scopes: { request: async () => { throw other; } }, redirect, requested: ["read_themes"] }));
  assert.equal(t2, other);
});

console.log("a rota");
await check("a rota usa o helper com read_themes, sem write_themes e sem redirect cru", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(cwd, "app/routes/api.shopify.grant-themes-scope.jsx"), "utf8");
  assert.match(src, /requestScopesOutOfFrame\(\{ scopes, redirect, requested: \["read_themes"\] \}\)/);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /write_themes/);
  assert.doesNotMatch(code, /from "react-router"/);
});
await check("o botão usa fetch (session token), não window.open na janela de topo", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(cwd, "app/routes/app.settings.jsx"), "utf8");
  assert.match(src, /themeScopeFetcher\.load\("\/api\/shopify\/grant-themes-scope"\)/);
  assert.doesNotMatch(src, /window\.open\("\/api\/shopify\/grant-themes-scope"/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nrequest-scopes: todos os casos passaram");
process.exit(0);
