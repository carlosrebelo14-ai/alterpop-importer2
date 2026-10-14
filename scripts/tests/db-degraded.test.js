#!/usr/bin/env node
/**
 * Decisão 34 (Lote 0) — modo degradado da BD: flag, guardas de escrita e de leitura.
 * Uso: node scripts/tests/db-degraded.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-degraded-"));
process.env.DATABASE_URL = `file:${path.join(tmp, "dev.sqlite")}`;

const {
  DbDegradedError,
  assertDbNotDegraded,
  clearDbDegraded,
  dbDegradedFlagPath,
  markDbDegraded,
  readDbDegraded,
} = await import("../../lib/health/dbDegraded.js");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

console.log("dbDegraded — flag");
await check("sem flag, BD saudável e escrita passa", () => {
  clearDbDegraded();
  assert.equal(readDbDegraded(), null);
  assert.doesNotThrow(() => assertDbNotDegraded("teste"));
});
await check("markDbDegraded grava a flag ao lado do ficheiro da BD", () => {
  const state = markDbDegraded("corrupção de teste");
  assert.equal(path.dirname(dbDegradedFlagPath()), tmp);
  assert.equal(readDbDegraded().cause, "corrupção de teste");
  assert.equal(readDbDegraded().at, state.at);
});
await check("assertDbNotDegraded lança DbDegradedError com código e causa", () => {
  try {
    assertDbNotDegraded("publicação");
    assert.fail("devia lançar");
  } catch (err) {
    assert.ok(err instanceof DbDegradedError);
    assert.equal(err.code, "DB_DEGRADED");
    assert.match(err.message, /corrupção de teste/);
    assert.match(err.message, /publicação/);
  }
});
await check("flag ilegível conta como degradado (na dúvida, bloqueia)", () => {
  fs.writeFileSync(dbDegradedFlagPath(), "{ não é json", "utf8");
  const state = readDbDegraded();
  assert.ok(state, "tem de bloquear");
  assert.match(state.cause, /corrompida/);
  clearDbDegraded();
});
await check("clearDbDegraded remove a flag e a escrita volta", () => {
  markDbDegraded("teste");
  clearDbDegraded();
  assert.equal(readDbDegraded(), null);
});

console.log("db.server — guarda de escrita");
const { default: prisma } = await import("../../app/db.server.js");

await check("sem flag, escrita SQL raw passa", async () => {
  clearDbDegraded();
  await prisma.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS probe (x INTEGER)");
});
await check("com flag, escrita SQL raw é recusada", async () => {
  markDbDegraded("teste");
  await assert.rejects(() => prisma.$executeRawUnsafe("INSERT INTO probe VALUES (1)"), DbDegradedError);
});
await check("com flag, escrita por modelo é recusada antes de chegar à BD", async () => {
  await assert.rejects(
    () => prisma.catalogProduct.create({ data: { shop: "x", sku: "y", title: "z" } }),
    DbDegradedError
  );
});
await check("com flag, leitura continua a passar", async () => {
  const rows = await prisma.$queryRawUnsafe("SELECT count(*) AS n FROM probe");
  assert.ok(Array.isArray(rows));
});
await check("sem flag outra vez, escrita volta", async () => {
  clearDbDegraded();
  await prisma.$executeRawUnsafe("INSERT INTO probe VALUES (2)");
});

console.log("fila e stock — escrita recusada, nada tocado");
const queue = await import("../../lib/curation/curationQueue.server.js");
await check("fila: saveCurationQueue recusa com flag", async () => {
  markDbDegraded("teste");
  await assert.rejects(() => queue.saveCurationQueue({ version: 1, items: [] }), DbDegradedError);
  clearDbDegraded();
});
const stock = await import("../../lib/importer/shopify/publishedStockSync.server.js");
await check("sync de stock recusa com flag antes de chamar a Shopify", async () => {
  markDbDegraded("teste");
  const client = {
    graphql: () => {
      throw new Error("não devia chamar a Shopify");
    },
  };
  await assert.rejects(() => stock.syncPublishedStockLevels(client, "loja.myshopify.com"), DbDegradedError);
  clearDbDegraded();
});

console.log("revisão adversarial — escapes fechados");
const { safePrisma } = await import("../../lib/prisma/prismaSafe.server.js");
await check("safePrisma propaga DbDegradedError mesmo com fallback (sem fallback silencioso)", async () => {
  markDbDegraded("teste");
  await assert.rejects(
    () => safePrisma("teste-escrita", () => prisma.catalogProduct.create({ data: { shop: "x", sku: "y", title: "z" } }), { fallback: 1 }),
    DbDegradedError
  );
  clearDbDegraded();
});
await check("safePrisma com causa que cita SQLite não reentra no ramo de corrupção", async () => {
  markDbDegraded("database disk image is malformed");
  const before = fs.readdirSync(tmp).filter((f) => f.includes(".corrupt-")).length;
  await assert.rejects(
    () => safePrisma("teste-reentrada", () => prisma.catalogProduct.create({ data: { shop: "x", sku: "y", title: "z" } })),
    (err) => err instanceof DbDegradedError && !/aninhad/.test(err.message)
  );
  const after = fs.readdirSync(tmp).filter((f) => f.includes(".corrupt-")).length;
  assert.equal(after, before, "a recusa não pode criar cópias do WAL");
  clearDbDegraded();
});
await check("$queryRawUnsafe com SQL de escrita é recusado; SELECT passa", async () => {
  markDbDegraded("teste");
  await assert.rejects(() => prisma.$queryRawUnsafe("INSERT INTO probe VALUES (3)"), DbDegradedError);
  const rows = await prisma.$queryRawUnsafe("SELECT count(*) AS n FROM probe");
  assert.ok(Array.isArray(rows));
  clearDbDegraded();
});
const publisher = await import("../../lib/importer/shopify/shopifyProductPublisher.server.js");
await check("publicador de produto recusa antes de chamar a Shopify (cobre scripts diretos)", async () => {
  markDbDegraded("teste");
  const client = {
    graphql: () => {
      throw new Error("não devia chamar a Shopify");
    },
  };
  await assert.rejects(() => publisher.publishCatalogProductToShopify(client, { sku: "x" }, {}), DbDegradedError);
  clearDbDegraded();
});
await check("entradas de escrita têm guarda antes da primeira ação", () => {
  const guard = (rel, needle) => {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    const at = src.indexOf(needle);
    assert.ok(at > 0, `${rel}: guarda em falta`);
  };
  guard("lib/importer/jobs/runImport.js", 'assertDbNotDegraded("importação")');
  guard("lib/importer/catalog/indexingStream.server.js", 'assertDbNotDegraded("purga do catálogo")');
  guard("lib/importer/catalog/indexingStream.server.js", 'assertDbNotDegraded("reindexação do catálogo")');
  guard("lib/importer/shopify/publishedReprice.server.js", 'assertDbNotDegraded("aplicar preços aos publicados")');
  guard("app/routes/api.shopify-reset.jsx", "readDbDegraded()");
  guard("lib/curation/curationQueue.server.js", 'assertDbNotDegraded("recuperação da fila de curadoria")');
  guard("lib/curation/curationQueue.server.js", 'assertDbNotDegraded("reinício da fila de curadoria")');
});

console.log("rotas e painel — ligação ao guarda");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
await check("api.shopify-sync recusa com 503 antes de iniciar o job", () => {
  const src = read("app/routes/api.shopify-sync.jsx");
  const guard = src.indexOf("readDbDegraded()");
  assert.ok(guard > 0, "guarda em falta");
  assert.ok(src.includes("status: 503"), "tem de responder 503");
  assert.ok(guard < src.indexOf("await initShopifySyncJob(session.shop, approvedSkus.length)"), "guarda depois do job");
});
await check("api.trigger-sync não arranca o ciclo em modo degradado", () => {
  const src = read("app/routes/api.trigger-sync.jsx");
  const guard = src.indexOf("readDbDegraded()");
  assert.ok(guard > 0, "guarda em falta");
  assert.ok(guard < src.indexOf("const startedAt = new Date().toISOString()"), "guarda depois do arranque");
});
await check("publicação recusa antes de ler a fila", () => {
  const src = read("lib/importer/shopify/shopifyApprovedSync.server.js");
  const guard = src.indexOf('assertDbNotDegraded("publicação Shopify")');
  assert.ok(guard > 0, "guarda em falta");
  assert.ok(guard < src.indexOf('listCurationQueueItems("APPROVED")'), "guarda depois da leitura da fila");
});
await check("painel mostra o banner com a causa", () => {
  const src = read("app/routes/app.jsx");
  assert.ok(src.includes("dbDegraded: readDbDegraded()"), "loader não devolve o estado");
  assert.ok(src.includes('tone="critical"'), "banner em falta");
});

clearDbDegraded();
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
process.exit(0);
