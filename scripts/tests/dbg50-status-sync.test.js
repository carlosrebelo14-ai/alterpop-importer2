#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-50 — o estado Shopify do sync vem da fila de curadoria, não das regras.
 *
 * Antes: resolveProductStatus caía em evaluateCurationRules para qualquer entrada que
 * não fosse APPROVED nem REJECTED. Uma entrada PENDING com marca e categoria permitidas
 * saía ACTIVE. E productCreate/productUpdate tinham o default "ACTIVE".
 *
 * Agora: só APPROVED e PUBLISHED dão ACTIVE. Produto novo nasce DRAFT, salvo decisão da
 * fila. Produto já existente com entrada pendente não recebe `status` no update.
 *
 * Isolamento: CURATION_DATA_DIR aponta para um diretório temporário. A Shopify é um
 * cliente falso, e os SKUs são sintéticos (DBG50-...).
 *
 * Uso: node scripts/tests/dbg50-status-sync.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg50-status-sync-"));
process.env.CURATION_DATA_DIR = tmpDir;
const QUEUE_PATH = path.join(tmpDir, "curation-queue.json");
fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items: [] }));

const gate = await import("../../lib/importer/curation/visibilityGatekeeper.js");
const { loadCuration } = await import("../../lib/importer/curation/loadCuration.js");
const q = await import("../../lib/curation/curationQueue.server.js");
const { ProductImporter, statusParaProdutoNovo, statusParaProdutoExistente } = await import(
  "../../lib/importer/importers/ProductImporter.js"
);

// Marca premium do config real (só leitura). Categoria sintética, que nunca está bloqueada.
const MARCA = loadCuration().premiumBrands[0];
const CATEGORIA = "Categoria de Teste DBG50";
assert.ok(MARCA, "precondição: config/curation.json tem marca premium");

function registo(sku) {
  return {
    sku,
    title: `Produto de teste ${sku}`,
    vendor: MARCA,
    categoryMain: CATEGORIA,
    distributorPrice: 10,
    grossPrice: 15,
    netPrice: 10,
    availableQuantity: 3,
  };
}

/** Cliente GraphQL falso: regista cada chamada e responde o mínimo que o importador lê. */
function clienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    async graphql(query, variables) {
      chamadas.push({ query, variables });
      if (/mutation ProductCreate\b/.test(query)) {
        return {
          productCreate: {
            product: {
              id: "gid://shopify/Product/8801",
              title: "Criado",
              variants: {
                nodes: [{ id: "gid://shopify/ProductVariant/8801", sku: "", inventoryItem: { id: "gid://shopify/InventoryItem/8801" } }],
              },
            },
            userErrors: [],
          },
        };
      }
      if (/mutation VariantsBulkUpdate\b/.test(query)) {
        return {
          productVariantsBulkUpdate: {
            productVariants: [{ id: "gid://shopify/ProductVariant/8801", sku: "", inventoryItem: { id: "gid://shopify/InventoryItem/8801" } }],
            userErrors: [],
          },
        };
      }
      if (/mutation ProductUpdate\b/.test(query)) {
        return { productUpdate: { product: { id: "gid://shopify/Product/9001", title: "Existente" }, userErrors: [] } };
      }
      return {};
    },
  };
}

function jobFalso() {
  return {
    mode: "LIVE",
    jobId: "dbg50-test",
    metrics: { productsCreated: 0, productsUpdated: 0, pricesUpdated: 0 },
    recordSuccess() {},
    recordFailed() {},
    recordCuratedDraft() {},
    recordProductActive() {},
    tallyCurationReasons() {},
  };
}

function importadorFalso(client) {
  const imp = new ProductImporter(jobFalso(), client, {
    syncImages: false,
    syncPrices: false,
    importMode: "CREATE_AND_UPDATE",
  });
  imp.logSync = () => {}; // sem SKU nos logs
  return imp;
}

function variantExistente(sku) {
  return {
    id: "gid://shopify/ProductVariant/9001",
    sku,
    price: "12.00",
    inventoryItem: { id: "gid://shopify/InventoryItem/9001" },
    product: { id: "gid://shopify/Product/9001", title: "Existente", syncLocked: false },
  };
}

const chamadasDo = (client, re) => client.chamadas.filter((c) => re.test(c.query));

/** Input enviado no productUpdate de um produto existente. */
async function inputDoUpdateExistente({ entrada, semCuradoria = false }) {
  const record = registo("DBG50-EXIST-1");
  const client = clienteFalso();
  const imp = importadorFalso(client);
  if (!semCuradoria) await imp.applyCuration(record, CATEGORIA, entrada);
  await imp.updateProduct(record, variantExistente(record.sku), CATEGORIA);
  const [upd] = chamadasDo(client, /mutation ProductUpdate\b/);
  assert.ok(upd, "o update tem de chamar productUpdate");
  return upd.variables.input;
}

/** Chamadas de um produto novo: productCreate e os productUpdate que aplicam o estado. */
async function criacaoNova({ entrada, semCuradoria = false }) {
  const record = registo("DBG50-NEW-1");
  const client = clienteFalso();
  const imp = importadorFalso(client);
  if (!semCuradoria) await imp.applyCuration(record, CATEGORIA, entrada);
  await imp.createProduct(record, CATEGORIA);
  const [create] = chamadasDo(client, /mutation ProductCreate\b/);
  const updates = chamadasDo(client, /mutation ProductUpdate\b/);
  return {
    productCreateStatus: create.variables.product.status,
    estadosDoUpdate: updates.map((u) => u.variables.input.status),
  };
}

const testes = [];
const teste = (nome, fn) => testes.push({ nome, fn });

// --- 1. Decisão da fila (gatekeeper) -------------------------------------------------

const CASOS_FILA = [
  { nome: "APPROVED", entrada: { status: "APPROVED", reason: "motivo_x" }, status: "ACTIVE", pending: false, queueStatus: "APPROVED" },
  { nome: "PUBLISHED", entrada: { status: "PUBLISHED" }, status: "ACTIVE", pending: false, queueStatus: "PUBLISHED" },
  { nome: "REJECTED", entrada: { status: "REJECTED" }, status: "DRAFT", pending: false, queueStatus: "REJECTED" },
  { nome: "PENDING", entrada: { status: "PENDING", reason: "brand_not_allowed" }, status: "DRAFT", pending: true, queueStatus: "PENDING" },
  { nome: "outro estado (SYNC_ERROR)", entrada: { status: "SYNC_ERROR" }, status: "DRAFT", pending: true, queueStatus: "SYNC_ERROR" },
  { nome: "sem entrada", entrada: null, status: "DRAFT", pending: true, queueStatus: null },
];

for (const caso of CASOS_FILA) {
  teste(`gatekeeper, entrada ${caso.nome}: estado, pendente e queueStatus`, async () => {
    const r = await gate.resolveProductStatus(registo(`DBG50-FILA-${caso.queueStatus ?? "NONE"}`), caso.entrada);
    assert.equal(r.status, caso.status);
    assert.equal(r.pending, caso.pending);
    assert.equal(r.queueStatus, caso.queueStatus);
  });
}

teste("gatekeeper: APPROVED mantém as reasons de hoje (manual_approved + motivo da entrada)", async () => {
  const r = await gate.resolveProductStatus(registo("DBG50-REASON-1"), { status: "APPROVED", reason: "motivo_x" });
  assert.deepEqual(r.reasons, ["manual_approved", "motivo_x"]);
});

teste("gatekeeper: PENDING sem motivo na entrada fica com reason pending_review", async () => {
  const r = await gate.resolveProductStatus(registo("DBG50-REASON-2"), { status: "PENDING" });
  assert.deepEqual(r.reasons, ["pending_review"]);
});

teste("gatekeeper: as regras dariam ACTIVE, mas PENDING, outro estado e sem entrada ficam DRAFT", async () => {
  const record = registo("DBG50-RULE-1");
  assert.equal(gate.evaluateCurationRules(record).status, "ACTIVE", "precondição: as regras dariam ACTIVE");
  for (const entrada of [{ status: "PENDING" }, { status: "SYNC_ERROR" }, null]) {
    const r = await gate.resolveProductStatus(record, entrada);
    assert.equal(r.status, "DRAFT", `entrada ${entrada?.status ?? "sem entrada"} não pode ser ACTIVE`);
  }
});

teste("gatekeeper: sem entrada passada, lê a fila em disco (cache) e aceita a entrada explícita depois de aprovar", async () => {
  const sku = "DBG50-CACHE-1";
  fs.writeFileSync(
    QUEUE_PATH,
    JSON.stringify({
      version: 1,
      updatedAt: null,
      items: [{ sku, title_en: "x", status: "PENDING", reason: "brand_not_allowed", shopifyStatus: "DRAFT", metadata: {} }],
    })
  );
  gate.invalidateCurationQueueCache();
  const pelaCache = await gate.resolveProductStatus(registo(sku));
  assert.equal(pelaCache.status, "DRAFT");
  assert.equal(pelaCache.queueStatus, "PENDING");

  await q.approveProduct(sku);
  const entradaFresca = await q.getCurationQueueEntry(sku);
  const explicita = await gate.resolveProductStatus(registo(sku), entradaFresca);
  assert.equal(explicita.status, "ACTIVE");
});

// --- 2. Upsert devolve a entrada gravada -------------------------------------------

teste("upsertCurationQueueFromRecord devolve a entrada gravada, com o estado que ficou no ficheiro", async () => {
  const sku = "DBG50-UPS-1";
  const devolvida = await q.upsertCurationQueueFromRecord(registo(sku));
  assert.equal(devolvida.sku, sku);
  const noFicheiro = (await q.listCurationQueueItems()).find((i) => i.sku === sku);
  assert.equal(devolvida.status, noFicheiro.status);
});

teste("upsertCurationQueueFromRecord numa entrada existente devolve a entrada atualizada", async () => {
  const sku = "DBG50-UPS-2";
  await q.upsertCurationQueueFromRecord(registo(sku));
  const segunda = await q.upsertCurationQueueFromRecord(registo(sku));
  assert.equal(segunda.sku, sku);
  const noFicheiro = (await q.listCurationQueueItems()).filter((i) => i.sku === sku);
  assert.equal(noFicheiro.length, 1, "um único registo por SKU");
  assert.equal(segunda.status, noFicheiro[0].status);
});

// --- 3. Funções puras de estado -----------------------------------------------------

teste("statusParaProdutoNovo: só ACTIVE com decisão da fila; sem resolução o default é DRAFT", () => {
  assert.equal(statusParaProdutoNovo(undefined), "DRAFT");
  assert.equal(statusParaProdutoNovo(null), "DRAFT");
  assert.equal(statusParaProdutoNovo({ status: "DRAFT", pending: true }), "DRAFT");
  assert.equal(statusParaProdutoNovo({ status: "DRAFT", pending: false }), "DRAFT");
  assert.equal(statusParaProdutoNovo({ status: "ACTIVE", pending: false }), "ACTIVE");
});

teste("statusParaProdutoExistente: pendente ou sem resolução não envia status", () => {
  assert.equal(statusParaProdutoExistente(undefined), null);
  assert.equal(statusParaProdutoExistente({ status: "DRAFT", pending: true }), null);
  assert.equal(statusParaProdutoExistente({ status: "ACTIVE", pending: true }), null);
});

teste("statusParaProdutoExistente: decisão da fila envia status (ACTIVE ou DRAFT)", () => {
  assert.equal(statusParaProdutoExistente({ status: "ACTIVE", pending: false }), "ACTIVE");
  assert.equal(statusParaProdutoExistente({ status: "DRAFT", pending: false }), "DRAFT");
});

// --- 4. Produto existente: productUpdate ------------------------------------------

teste("existente + PENDING: update sem campo status (ACTIVE na loja fica como está; DRAFT também)", async () => {
  const input = await inputDoUpdateExistente({ entrada: { status: "PENDING" } });
  assert.equal("status" in input, false);
});

teste("existente + sem entrada: update sem campo status", async () => {
  const input = await inputDoUpdateExistente({ entrada: null });
  assert.equal("status" in input, false);
});

teste("existente + outro estado (SYNC_ERROR): update sem campo status", async () => {
  const input = await inputDoUpdateExistente({ entrada: { status: "SYNC_ERROR" } });
  assert.equal("status" in input, false);
});

teste("existente sem resolução conhecida (curadoria não correu): update sem campo status", async () => {
  const input = await inputDoUpdateExistente({ semCuradoria: true });
  assert.equal("status" in input, false);
});

teste("existente + APPROVED: update com status ACTIVE", async () => {
  const input = await inputDoUpdateExistente({ entrada: { status: "APPROVED" } });
  assert.equal(input.status, "ACTIVE");
});

teste("existente + PUBLISHED: update com status ACTIVE", async () => {
  const input = await inputDoUpdateExistente({ entrada: { status: "PUBLISHED" } });
  assert.equal(input.status, "ACTIVE");
});

teste("existente + REJECTED: update com status DRAFT", async () => {
  const input = await inputDoUpdateExistente({ entrada: { status: "REJECTED" } });
  assert.equal(input.status, "DRAFT");
});

// --- 5. Produto novo: productCreate e productUpdate de estado ----------------------

for (const caso of [
  { nome: "PENDING", entrada: { status: "PENDING" } },
  { nome: "sem entrada", entrada: null },
  { nome: "outro estado (SYNC_ERROR)", entrada: { status: "SYNC_ERROR" } },
  { nome: "REJECTED", entrada: { status: "REJECTED" } },
]) {
  teste(`novo + ${caso.nome}: productCreate em DRAFT e nenhum productUpdate com status`, async () => {
    const r = await criacaoNova({ entrada: caso.entrada });
    assert.equal(r.productCreateStatus, "DRAFT");
    assert.deepEqual(r.estadosDoUpdate, []);
  });
}

teste("novo + APPROVED: nasce DRAFT e um productUpdate põe ACTIVE depois da variante ter preço", async () => {
  const r = await criacaoNova({ entrada: { status: "APPROVED" } });
  assert.equal(r.productCreateStatus, "DRAFT");
  assert.deepEqual(r.estadosDoUpdate, ["ACTIVE"]);
});

teste("novo + PUBLISHED: productUpdate põe ACTIVE", async () => {
  const r = await criacaoNova({ entrada: { status: "PUBLISHED" } });
  assert.deepEqual(r.estadosDoUpdate, ["ACTIVE"]);
});

teste("novo sem resolução (default): DRAFT e nenhum ACTIVE em lado nenhum", async () => {
  const r = await criacaoNova({ semCuradoria: true });
  assert.equal(r.productCreateStatus, "DRAFT");
  assert.deepEqual(r.estadosDoUpdate, []);
});

// --- 6. applyCuration usa a entrada passada ----------------------------------------

teste("applyCuration grava o estado e a resolução a partir da entrada passada", async () => {
  const imp = importadorFalso(clienteFalso());
  const aprovado = registo("DBG50-AC-1");
  await imp.applyCuration(aprovado, CATEGORIA, { status: "APPROVED", reason: "motivo_x" });
  assert.equal(aprovado._shopifyStatus, "ACTIVE");
  assert.equal(aprovado._curationResolution.pending, false);

  const pendente = registo("DBG50-AC-2");
  await imp.applyCuration(pendente, CATEGORIA, { status: "PENDING" });
  assert.equal(pendente._shopifyStatus, "DRAFT");
  assert.equal(pendente._curationResolution.pending, true);
});

// --- Execução ----------------------------------------------------------------------

async function correrTestes() {
  let falhas = 0;
  for (const { nome, fn } of testes) {
    try {
      await fn();
      console.log(`  ok  ${nome}`);
    } catch (err) {
      falhas += 1;
      console.error(`FAIL  ${nome}\n      ${err.message}`);
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (falhas) {
    console.error(`\ndbg50-status-sync: ${falhas} falha(s) de ${testes.length}`);
    process.exitCode = 1;
  } else {
    console.log(`\ndbg50-status-sync: todos os ${testes.length} casos passaram`);
  }
}

await correrTestes();
