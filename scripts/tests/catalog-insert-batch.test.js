#!/usr/bin/env node
/**
 * B7 (ADENDA 3, 17/09/2026) — regressão do bug real: catalogInsertBatch.server.js
 * (o upsert usado pelo sync incremental, syncCatalogWithProgress.server.js) tinha uma
 * lista de colunas escrita à mão, separada de catalogProductsDb.server.js. Quando
 * resolvedCharacters entrou no schema, só se acrescentou a esse outro ficheiro — este
 * INSERT continuou sem a coluna, e cada sync normal reescrevia resolvedCharacters para
 * NULL mesmo depois do backfill. Verificado contra a loja real (SKU 4983164885040:
 * resolvedCharacters voltou a NULL às 16:38 do dia do piloto, depois do backfill).
 *
 * Este teste fixa o contrato: toda coluna nova em CatalogProduct usada pelo publish
 * (resolved*) tem de aparecer na lista única UPSERT_COLUMNS — e portanto no INSERT, no
 * ON CONFLICT SET e nos params — ao mesmo tempo, sem escrever as três listas à mão.
 *
 * Uso: node scripts/tests/catalog-insert-batch.test.js
 */
import assert from "node:assert/strict";
import { buildCatalogUpsertStatement } from "../../lib/importer/catalog/catalogInsertBatch.server.js";

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

const SHOP = "jyr17t-wr.myshopify.com";
const sampleProduct = {
  sku: "SKU-1",
  title: "One Piece Luffy figure",
  categoryMain: "Anime",
  categorySegments: ["Anime"],
  vendor: "Banpresto",
  stock: 5,
  franchises: ["One Piece"],
  franchiseRefs: ["One Piece"],
  resolvedFranchise: "One Piece",
  resolvedFranchiseLayer: 1,
  resolvedLine: null,
  netPrice: 10,
  grossPrice: 12,
  imageUrl: null,
  barcode: "SKU-1",
  weightKg: 0.1,
  titleSource: "supplier",
  dimensions: null,
  hsCode: null,
  originalTitle: "One Piece Luffy figure",
  cleanTitle: "One Piece Luffy figure",
  resolvedFormat: "Figure",
  resolvedManufacturerLine: null,
  resolvedCharacters: JSON.stringify(["luffy"]),
};

check("resolvedCharacters entra na lista de colunas do INSERT", () => {
  const { sql } = buildCatalogUpsertStatement(SHOP, [sampleProduct]);
  const columnList = sql.slice(sql.indexOf("("), sql.indexOf(")") + 1);
  assert.ok(columnList.includes("resolvedCharacters"), "resolvedCharacters não está na lista de colunas do INSERT");
});

check("resolvedCharacters entra no SET do ON CONFLICT (senão fica preso ao valor do 1.º INSERT)", () => {
  const { sql } = buildCatalogUpsertStatement(SHOP, [sampleProduct]);
  assert.ok(sql.includes("resolvedCharacters = excluded.resolvedCharacters"), "falta resolvedCharacters no ON CONFLICT DO UPDATE SET");
});

check("o valor de resolvedCharacters vai nos params, na posição da coluna", () => {
  const { sql, params } = buildCatalogUpsertStatement(SHOP, [sampleProduct]);
  const columnList = sql
    .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
    .split(",")
    .map((s) => s.trim());
  const idx = columnList.indexOf("resolvedCharacters");
  assert.ok(idx >= 0, "resolvedCharacters não está na lista de colunas");
  assert.equal(params[idx], JSON.stringify(["luffy"]));
});

check("resolvedCharacters null vira NULL nos params, não a string \"null\"", () => {
  const { sql, params } = buildCatalogUpsertStatement(SHOP, [{ ...sampleProduct, resolvedCharacters: null }]);
  const columnList = sql
    .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
    .split(",")
    .map((s) => s.trim());
  const idx = columnList.indexOf("resolvedCharacters");
  assert.equal(params[idx], null);
});

check("número de placeholders bate com o número de params por produto (2 produtos)", () => {
  const { sql, params } = buildCatalogUpsertStatement(SHOP, [sampleProduct, { ...sampleProduct, sku: "SKU-2" }]);
  const placeholderCount = (sql.match(/\?/g) || []).length;
  assert.equal(placeholderCount, params.length);
});

check("originalTitle não entra no SET do ON CONFLICT (Tarefa 10 — nunca reescrito)", () => {
  const { sql } = buildCatalogUpsertStatement(SHOP, [sampleProduct]);
  const setClause = sql.slice(sql.indexOf("DO UPDATE SET"));
  assert.ok(!setClause.includes("originalTitle = excluded.originalTitle"));
});

check("resolvedFormat/resolvedManufacturerLine (campos irmãos já existentes) continuam no INSERT e no SET", () => {
  const { sql } = buildCatalogUpsertStatement(SHOP, [sampleProduct]);
  for (const col of ["resolvedFormat", "resolvedManufacturerLine"]) {
    assert.ok(sql.includes(col), `${col} desapareceu do SQL`);
    assert.ok(sql.includes(`${col} = excluded.${col}`), `${col} desapareceu do SET`);
  }
});

console.log(`\n${failures === 0 ? "OK" : "FALHOU"} — ${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
