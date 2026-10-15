#!/usr/bin/env node
/* eslint-env node */
/**
 * Lote 2b-1, Decisão 3 do arquiteto (D6). Regras de painel e decisões humanas.
 *
 * - Uma regra de painel (server/data/rules.json, criada em app._index.jsx) só age sobre um item
 *   PENDING sem statusChangedAt. Um item com decisão humana não volta a APPROVED nem a REJECTED
 *   por regra (caso H1, H1s, H2).
 * - Um item já decidido por regra de painel só muda enquanto for PENDING sem decisão humana (H7).
 * - Um item novo só nasce APPROVED ou REJECTED por regra de painel, com metadata.origem = "regra"
 *   (H4, H4b). Sem regra de painel, nasce PENDING (H3).
 * - A origem "regra" não passa para um item que o humano decidiu depois da leitura do worker (H6).
 * - Controlo: uma regra de painel ainda aplica a PENDING sem decisão humana (H5).
 *
 * Usa PROJECT_ROOT e CURATION_DATA_DIR em diretórios temporários. Não toca nos dados reais.
 *
 * Uso: node scripts/tests/curation-regra-painel.test.js
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

// Raiz de projeto temporária: só a configuração que as regras leem. PROJECT_ROOT é lido ao
// carregar config.js, por isso tem de estar definido antes dos imports dinâmicos abaixo.
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "regra-painel-root-"));
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

const DECIDIDO = "2026-10-14T10:00:00.000Z";
const REGRA_APROVA_LEGO = { id: "rule_painel_lego", action: "AUTO_APPROVE", brand: "LEGO" };

function escreverRegras(regras) {
  fs.writeFileSync(RULES_PATH, JSON.stringify({ version: 1, rules: regras }));
  smart.invalidateSmartRulesCache();
}

function escreverFila(items) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items }));
  q.invalidateCurationMemoryCache();
}

/** Registo de marca premium (LEGO passa a Elite por marca, sem regra de exclusão). */
const registo = (sku, vendor = "LEGO") => ({
  sku,
  title: `Produto ${sku}`,
  vendor,
  categoryMain: "Juguetes",
  netPrice: 20,
  grossPrice: 24,
  availableQuantity: 5,
});

const itemDe = (fila, sku) => fila.items.find((i) => i.sku === sku);

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
  await caso("H1 lote: regra de painel não põe APPROVED sobre PENDING com decisão humana", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([
      { sku: "H1", title_en: "H1", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", statusChangedAt: DECIDIDO, metadata: {} },
    ]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("H1")], { queue: fila });
    assert.equal(itemDe(fila, "H1").status, "PENDING");
  });

  await caso("H1s unitário: regra de painel não põe APPROVED sobre PENDING com decisão humana", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([
      { sku: "H1s", title_en: "H1s", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", statusChangedAt: DECIDIDO, metadata: {} },
    ]);
    await q.upsertCurationQueueFromRecord(registo("H1s"));
    const item = await q.getCurationQueueEntry("H1s");
    assert.equal(item.status, "PENDING");
  });

  await caso("H2 unitário: regra de painel não repõe APPROVED sobre REJECTED humano com metadata de regra", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([
      {
        sku: "H2",
        title_en: "H2",
        status: "REJECTED",
        reason: "manual_dashboard",
        shopifyStatus: "DRAFT",
        statusChangedAt: DECIDIDO,
        metadata: {
          smartRule: true,
          smartAction: "AUTO_APPROVE",
          smartRuleId: "rule_painel_lego",
          approvedAt: "2026-10-10T00:00:00.000Z",
          rejectedAt: DECIDIDO,
        },
      },
    ]);
    await q.upsertCurationQueueFromRecord(registo("H2"));
    const item = await q.getCurationQueueEntry("H2");
    assert.equal(item.status, "REJECTED");
  });

  await caso("H3 item novo sem regra de painel nasce PENDING", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([]);
    // Funko é marca premium, mas a regra de painel é só para LEGO.
    await q.upsertCurationQueueFromRecord(registo("H3", "Funko"));
    const item = await q.getCurationQueueEntry("H3");
    assert.equal(item.status, "PENDING");
    assert.equal(item.metadata.origem, undefined);
  });

  await caso("H4 item novo com regra de painel nasce APPROVED com origem 'regra' (unitário)", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([]);
    await q.upsertCurationQueueFromRecord(registo("H4"));
    const item = await q.getCurationQueueEntry("H4");
    assert.equal(item.status, "APPROVED");
    assert.equal(item.metadata.origem, "regra");
  });

  await caso("H4b item novo com regra de painel nasce APPROVED com origem 'regra' (lote)", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("H4b")], { queue: fila });
    const item = itemDe(fila, "H4b");
    assert.equal(item.status, "APPROVED");
    assert.equal(item.metadata.origem, "regra");
  });

  await caso("H5 controlo: regra de painel ainda aplica a PENDING sem decisão humana", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([{ sku: "H5", title_en: "H5", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", metadata: {} }]);
    await q.upsertCurationQueueFromRecord(registo("H5"));
    const item = await q.getCurationQueueEntry("H5");
    assert.equal(item.status, "APPROVED");
  });

  await caso("H6 flush do worker não copia origem 'regra' para item decidido pelo humano depois da leitura", async () => {
    escreverRegras([]);
    escreverFila([
      { sku: "H6", title_en: "H6", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", statusChangedAt: "2026-10-15T12:00:00.000Z", metadata: {} },
    ]);
    // O worker leu às 11:00 e calculou APPROVED por regra. O humano decidiu às 12:00.
    await q.flushCurationQueueItems(
      [
        {
          sku: "H6",
          title_en: "H6",
          status: "APPROVED",
          reason: "smart_rule:rule_painel_lego",
          shopifyStatus: "ACTIVE",
          metadata: { smartRule: true, origem: "regra", approvedAt: "2026-10-15T11:00:00.000Z" },
        },
      ],
      { readAt: Date.parse("2026-10-15T11:00:00.000Z") }
    );
    const fila = await q.loadCurationQueue();
    const item = itemDe(fila, "H6");
    assert.equal(item.status, "PENDING");
    assert.equal(item.metadata.origem, undefined);
  });

  await caso("H7 item APPROVED por regra sem decisão humana não é recalculado pela regra", async () => {
    escreverRegras([{ id: "rule_painel_lego_rej", action: "AUTO_REJECT", brand: "LEGO" }]);
    escreverFila([
      {
        sku: "H7",
        title_en: "H7",
        status: "APPROVED",
        reason: "smart_rule:rule_painel_lego",
        shopifyStatus: "ACTIVE",
        metadata: { smartRule: true, smartAction: "AUTO_APPROVE", smartRuleId: "rule_painel_lego", approvedAt: DECIDIDO, rejectedAt: null },
      },
    ]);
    await q.upsertCurationQueueFromRecord(registo("H7"));
    const item = await q.getCurationQueueEntry("H7");
    assert.equal(item.status, "APPROVED");
  });

  fs.rmSync(projectRoot, { recursive: true, force: true });

  if (falhas) {
    console.error(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log("\ncuration-regra-painel: todos os casos passaram");
}

main();
