#!/usr/bin/env node
/* eslint-env node */
/**
 * URL do feed OcioStock: segredo, só vem de OCIOSTOCK_FEED_URL.
 *   - nenhum ficheiro rastreado tem o URL do feed (nem o caminho com hash);
 *   - sem a variável (nem OCIOSTOCK_CSV_PATH) a leitura e o descarregamento falham com erro claro;
 *   - a variável antiga OCIOSTOCK_CSV_URL e um URL guardado nas definições são ignorados;
 *   - o URL nunca vai para o log.
 * Uso: node scripts/tests/ociostock-feed-url.test.js
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cwd = process.cwd();
process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "feed-url-unused.sqlite")}`;
delete process.env.OCIOSTOCK_FEED_URL;
delete process.env.OCIOSTOCK_CSV_URL;
delete process.env.OCIOSTOCK_CSV_PATH;

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

const cfgMod = await import(path.join(cwd, "lib/importer/config.js"));

await check("nenhum ficheiro rastreado tem o URL do feed nem o caminho com hash", () => {
  const re = "dyndata/exportaciones|catalog_[0-9_]+_[0-9a-f]{32}|ociostock\\.gesio\\.be/dyn";
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-I", "-l", "-E", re, "--", ".", ":!scripts/tests/ociostock-feed-url.test.js"], { cwd, encoding: "utf8" });
  } catch (err) {
    if (err.status !== 1) throw err; // 1 = sem resultados
  }
  assert.equal(out.trim(), "", `URL do feed encontrado em:\n${out}`);
});
await check("a configuração lê OCIOSTOCK_FEED_URL e ignora a variável antiga", () => {
  process.env.OCIOSTOCK_CSV_URL = "https://antigo.invalid/x.csv";
  assert.equal(cfgMod.getDefaultConfig().ociostock.csvUrl, "");
  process.env.OCIOSTOCK_FEED_URL = "https://novo.invalid/feed.csv";
  assert.equal(cfgMod.getDefaultConfig().ociostock.csvUrl, "https://novo.invalid/feed.csv");
  delete process.env.OCIOSTOCK_FEED_URL;
  delete process.env.OCIOSTOCK_CSV_URL;
});
await check("sem a variável, a leitura do feed falha com erro claro", async () => {
  const { streamOcioStockRows } = await import(path.join(cwd, "lib/importer/connectors/ociostock/streamCsv.js"));
  await assert.rejects(() => streamOcioStockRows({ onRow: async () => {} }), (e) => {
    assert.match(e.message, /OCIOSTOCK_FEED_URL não está definida/);
    assert.match(e.message, /fly secrets set OCIOSTOCK_FEED_URL/);
    return true;
  });
});
await check("sem a variável, o descarregamento do CSV falha (nunca usa URL antigo)", async () => {
  const { ensureLocalOcioStockCsv } = await import(path.join(cwd, "lib/importer/catalog/ensureLocalOcioStockCsv.server.js"));
  const shop = `feed-url-test-${process.pid}.myshopify.com`;
  await assert.rejects(() => ensureLocalOcioStockCsv(shop, { ociostockCsvUrl: "https://antigo.invalid/x.csv" }), /OCIOSTOCK_FEED_URL não está definida/);
});
await check("um URL guardado nas definições da loja é descartado e não existe por omissão", async () => {
  const settings = await import(path.join(cwd, "lib/importer/settings.server.js"));
  assert.equal("ociostockCsvUrl" in settings.getDefaultSettings(), false);
  const shop = `feed-url-test-${process.pid}.myshopify.com`;
  const dir = path.join(cfgMod.getDefaultConfig().paths.data, "settings");
  const file = path.join(dir, `${shop}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ociostockCsvUrl: "https://antigo.invalid/x.csv", priceMarginPct: 12 }));
  try {
    const loaded = await settings.loadShopSettings(shop);
    assert.equal("ociostockCsvUrl" in loaded, false);
    assert.equal(loaded.priceMarginPct, 12);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
await check("o URL nunca vai para o log nem para a interface", () => {
  const src = fs.readFileSync(path.join(cwd, "lib/importer/catalog/ensureLocalOcioStockCsv.server.js"), "utf8");
  assert.doesNotMatch(src, /console\.\w+\([^)]*csvUrl/);
  const ui = fs.readFileSync(path.join(cwd, "app/routes/app.settings.jsx"), "utf8");
  assert.doesNotMatch(ui, /ociostockCsvUrl/);
  const docker = fs.readFileSync(path.join(cwd, "Dockerfile"), "utf8");
  assert.doesNotMatch(docker, /OCIOSTOCK/);
  const example = fs.readFileSync(path.join(cwd, ".env.example"), "utf8");
  assert.match(example, /^OCIOSTOCK_FEED_URL=https:\/\/example\.invalid\//m);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nociostock-feed-url: todos os casos passaram");
process.exit(0);
