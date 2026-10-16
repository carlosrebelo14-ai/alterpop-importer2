#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 5 do arquiteto. O reset grava metadata.origem = "reset", e origem "reset" congela o item como
 * decisão humana: fica fora das regras de painel e da elite, no reindex (unitário e lote) e no flush do worker
 * (regra de 09/10/2026, Decisão 35, ponto 9, D15). A origem reset não é recalculada.
 *
 * - R1: item publicado revertido pelo reset para PENDING, com regra AUTO_APPROVE aplicável. Fica PENDING no
 *   reindex unitário, no lote e no flush do worker (leitura posterior ao reset, para que só a origem o proteja).
 * - R2: item revertido pelo reset para APPROVED, com regra AUTO_REJECT aplicável. Não é recalculado.
 * - R3: uma decisão humana posterior muda o item. approveProduct de um PENDING do reset dá APPROVED com origem
 *   "humano". rejectProduct de outro dá REJECTED com origem "humano". Depois, a regra não o recalcula.
 *
 * Usa PROJECT_ROOT e CURATION_DATA_DIR em diretórios temporários. Não toca nos dados reais nem na Shopify.
 *
 * Uso: node scripts/tests/curation-reset-origem.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const QUEUE_PATH = path.join(process.env.CURATION_DATA_DIR, "curation-queue.json");

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reset-origem-root-"));
fs.mkdirSync(path.join(projectRoot, "config"), { recursive: true });
fs.mkdirSync(path.join(projectRoot, "server", "data"), { recursive: true });
fs.copyFileSync(path.join(REPO, "config", "curation.json"), path.join(projectRoot, "config", "curation.json"));
fs.copyFileSync(
  path.join(REPO, "server", "data", "taxonomy-map.json"),
  path.join(projectRoot, "server", "data", "taxonomy-map.json")
);
const RULES_PATH = path.join(projectRoot, "server", "data", "rules.json");
process.env.PROJECT_ROOT = projectRoot;

const modulo = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
const q = await modulo("lib/curation/curationQueue.server.js");
const smart = await modulo("lib/importer/curation/smartRules.server.js");
const reset = await modulo("lib/importer/shopify/shopifyReset.server.js");

const DECIDIDO = "2026-10-01T10:00:00.000Z";
const REGRA_APROVA_LEGO = { id: "rule_painel_lego_ok", action: "AUTO_APPROVE", brand: "LEGO" };
const REGRA_REJEITA_LEGO = { id: "rule_painel_lego_rej", action: "AUTO_REJECT", brand: "LEGO" };

function escreverRegras(regras) {
  fs.writeFileSync(RULES_PATH, JSON.stringify({ version: 1, rules: regras }));
  smart.invalidateSmartRulesCache();
}

function escreverFila(items) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items }));
  q.invalidateCurationMemoryCache();
}

/** Registo de marca premium com preço acima do mínimo: a regra de painel é o que decide. */
const registo = (sku) => ({
  sku,
  title: `Produto ${sku}`,
  vendor: "LEGO",
  categoryMain: "Juguetes",
  netPrice: 20,
  grossPrice: 24,
  availableQuantity: 5,
});

const itemDe = (sku) => q.getCurationQueueEntry(sku);

/** Publicado na Shopify, com o vínculo que o reset limpa. */
const publicado = (sku) => ({
  sku,
  title_en: sku,
  status: "PUBLISHED",
  reason: "manual_dashboard",
  shopifyStatus: "ACTIVE",
  statusChangedAt: DECIDIDO,
  metadata: { origem: "humano", shopifyProductId: `gid://shopify/Product/${sku}`, publishedAt: DECIDIDO, approvedAt: DECIDIDO, rejectedAt: null },
});

let falhas = 0;
async function caso(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

async function main() {
  await caso("R1 reset para PENDING: fica PENDING com origem reset no reindex unitário, no lote e no flush", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([publicado("R1")]);
    const revertidos = await reset.revertAllPublishedInQueue({ targetStatus: "PENDING" });
    assert.equal(revertidos, 1);
    const apos = await itemDe("R1");
    assert.equal(apos.status, "PENDING");
    assert.equal(apos.metadata.origem, "reset", "o reset tem de gravar origem reset");

    // Reindex unitário: a regra AUTO_APPROVE não pode aprovar.
    await q.upsertCurationQueueFromRecord(registo("R1"));
    assert.equal((await itemDe("R1")).status, "PENDING", "reindex unitário recalculou um item de reset");

    // Reindex em lote.
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("R1")], { queue: fila });
    assert.equal(fila.items.find((i) => i.sku === "R1").status, "PENDING", "reindex em lote recalculou um item de reset");

    // Flush do worker lido depois do reset (statusChangedAt do reset é anterior à leitura): só a origem reset o pode proteger.
    const leituraDepois = Date.now() + 3_600_000;
    await q.flushCurationQueueItems(
      [{ sku: "R1", title_en: "R1", status: "APPROVED", reason: "smart_rule:rule_painel_lego_ok", shopifyStatus: "ACTIVE", metadata: { origem: "regra", smartRule: true, smartAction: "AUTO_APPROVE", approvedAt: "2026-10-16T11:00:00.000Z", rejectedAt: null } }],
      { readAt: leituraDepois }
    );
    const depoisFlush = await itemDe("R1");
    assert.equal(depoisFlush.status, "PENDING", "o flush do worker recalculou um item de reset");
    assert.equal(depoisFlush.metadata.origem, "reset");
  });

  // R1b: a origem reset sozinha congela o PENDING. Sem statusChangedAt (o reset grava-o, aqui é tirado de propósito),
  // o reindex unitário, o lote e o flush de um worker lido depois não o recalculam.
  await caso("R1b origem reset congela um PENDING sem statusChangedAt, no reindex e no flush", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([{ sku: "R1b", title_en: "R1b", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", metadata: { origem: "reset", syncError: null, shopifyResetAt: DECIDIDO } }]);
    await q.upsertCurationQueueFromRecord(registo("R1b"));
    assert.equal((await itemDe("R1b")).status, "PENDING", "reindex unitário recalculou um PENDING de reset");
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("R1b")], { queue: fila });
    assert.equal(fila.items.find((i) => i.sku === "R1b").status, "PENDING", "reindex em lote recalculou um PENDING de reset");
    await q.flushCurationQueueItems(
      [{ sku: "R1b", title_en: "R1b", status: "APPROVED", reason: "smart_rule:rule_painel_lego_ok", shopifyStatus: "ACTIVE", metadata: { origem: "regra", smartRule: true, smartAction: "AUTO_APPROVE", approvedAt: "2026-10-16T11:00:00.000Z", rejectedAt: null } }],
      { readAt: Date.now() + 3_600_000 }
    );
    assert.equal((await itemDe("R1b")).status, "PENDING", "o flush recalculou um PENDING de reset");
  });

  await caso("R2 reset para APPROVED: não é recalculado pela regra AUTO_REJECT aplicável (unitário e lote)", async () => {
    escreverRegras([REGRA_REJEITA_LEGO]);
    escreverFila([publicado("R2")]);
    await reset.revertAllPublishedInQueue({ targetStatus: "APPROVED" });
    const apos = await itemDe("R2");
    assert.equal(apos.status, "APPROVED");
    assert.equal(apos.metadata.origem, "reset");

    await q.upsertCurationQueueFromRecord(registo("R2"));
    assert.equal((await itemDe("R2")).status, "APPROVED", "reindex unitário recalculou um APPROVED de reset");

    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("R2")], { queue: fila });
    assert.equal(fila.items.find((i) => i.sku === "R2").status, "APPROVED", "reindex em lote recalculou um APPROVED de reset");
  });

  // R4: o reset com apagado na Shopify (deletedInAdmin) também grava origem reset, e o item fica retido.
  await caso("R4 reset com apagado na Shopify grava origem reset e o item fica retido em PENDING", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([publicado("R4")]);
    const revertidos = await reset.revertAllPublishedInQueue({ deletedInAdmin: true });
    assert.equal(revertidos, 1);
    const apos = await itemDe("R4");
    assert.equal(apos.status, "PENDING");
    assert.equal(apos.metadata.origem, "reset");
    assert.ok(apos.metadata.deletedInAdmin, "a marca de apagado tem de ficar");
    await q.upsertCurationQueueFromRecord(registo("R4"));
    assert.equal((await itemDe("R4")).status, "PENDING", "a regra recalculou um item apagado pelo reset");
  });

  await caso("R3 decisão humana depois do reset muda o item e grava origem humano; a regra não o recalcula", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([{ sku: "R3a", title_en: "R3a", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", metadata: { origem: "reset", syncError: null, shopifyResetAt: DECIDIDO } }, { sku: "R3b", title_en: "R3b", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", statusChangedAt: DECIDIDO, metadata: { origem: "reset" } }]);
    await q.approveProduct("R3a");
    const aprovado = await itemDe("R3a");
    assert.equal(aprovado.status, "APPROVED", "a aprovação humana tem de mudar o item de reset");
    assert.equal(aprovado.metadata.origem, "humano");

    await q.rejectProduct("R3b");
    const rejeitado = await itemDe("R3b");
    assert.equal(rejeitado.status, "REJECTED", "a rejeição humana tem de mudar o item de reset");
    assert.equal(rejeitado.metadata.origem, "humano");

    await q.upsertCurationQueueFromRecord(registo("R3b"));
    assert.equal((await itemDe("R3b")).status, "REJECTED", "a regra recalculou um item que o humano decidiu");
  });

  fs.rmSync(projectRoot, { recursive: true, force: true });

  if (falhas) {
    console.error(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log("\ncuration-reset-origem: todos os casos passaram");
}

main();
