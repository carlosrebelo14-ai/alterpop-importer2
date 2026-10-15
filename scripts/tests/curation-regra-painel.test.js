#!/usr/bin/env node
/* eslint-env node */
/**
 * Lote 2b-1, Decisão 3 do arquiteto (D6). Regras de painel e decisões humanas.
 *
 * - Uma regra de painel (server/data/rules.json, criada pelo painel via POST /api/smart-rules) só age sobre um item
 *   PENDING sem statusChangedAt. Um item com decisão humana não volta a APPROVED nem a REJECTED
 *   por regra (caso H1, H1s, H2).
 * - Um APPROVED ou REJECTED de regra (origem "regra") recalcula-se quando a regra muda. Sem regra
 *   aplicável, volta a PENDING (H7, H8).
 * - Decisão humana (origem "humano") fica congelada no reindex, no lote e no flush (H9).
 * - Um item novo só nasce APPROVED ou REJECTED por regra de painel, com metadata.origem = "regra"
 *   (H4, H4b). Sem regra de painel, nasce PENDING (H3).
 * - A origem "regra" não passa para um item que o humano decidiu depois da leitura do worker (H6).
 * - Controlo: uma regra de painel ainda aplica a PENDING sem decisão humana (H5).
 * - Elite: um item excluído pela elite nasce REJECTED com origem "elite" (E1). Um PENDING com
 *   statusChangedAt (devolvido pelo reset) fica fora da elite, como fica fora das regras (H11d).
 * - approveProduct e rejectProduct gravam origem "humano" e seguem a última decisão (H10).
 * - PENDING devolvido pelo reset ou apagado no admin não é recalculado (H11, regra de 09/10).
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

  // H7 mudou: antes o APPROVED de regra ficava congelado. Agora é automático e recalcula-se.
  // A regra de rejeição aplica-se a LEGO, por isso o item passa a REJECTED com origem "regra".
  await caso("H7 APPROVED de regra sem decisão humana é recalculado: a regra de rejeição aplica-se", async () => {
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
    assert.equal(item.status, "REJECTED");
    assert.equal(item.metadata.origem, "regra");
  });

  // H8: APPROVED de regra cuja regra já não se aplica volta a PENDING (unitário, lote e flush).
  const APROVADO_DE_REGRA = (sku) => ({
    sku,
    title_en: sku,
    status: "APPROVED",
    reason: "smart_rule:rule_painel_lego",
    shopifyStatus: "ACTIVE",
    metadata: { smartRule: true, smartAction: "AUTO_APPROVE", smartRuleId: "rule_painel_lego", origem: "regra", approvedAt: DECIDIDO, rejectedAt: null },
  });

  await caso("H8 APPROVED de regra com regra que já não se aplica volta a PENDING (unitário)", async () => {
    escreverRegras([]);
    escreverFila([APROVADO_DE_REGRA("H8")]);
    await q.upsertCurationQueueFromRecord(registo("H8"));
    const item = await q.getCurationQueueEntry("H8");
    assert.equal(item.status, "PENDING");
    assert.equal(item.metadata.origem, undefined);
    assert.equal(item.metadata.smartRule, undefined);
    assert.equal(item.metadata.approvedAt, null);
  });

  await caso("H8b APPROVED de regra com regra que já não se aplica volta a PENDING (lote)", async () => {
    escreverRegras([]);
    escreverFila([APROVADO_DE_REGRA("H8b")]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("H8b")], { queue: fila });
    const item = itemDe(fila, "H8b");
    assert.equal(item.status, "PENDING");
    assert.equal(item.metadata.origem, undefined);
  });

  await caso("H8c flush do worker: APPROVED de regra sem regra aplicável fica PENDING", async () => {
    escreverRegras([]);
    escreverFila([APROVADO_DE_REGRA("H8c")]);
    // O worker recalculou sem regra aplicável: manda PENDING, sem decisão humana depois da leitura.
    await q.flushCurationQueueItems(
      [{ sku: "H8c", title_en: "H8c", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", metadata: {} }],
      { readAt: Date.parse("2026-10-15T11:00:00.000Z") }
    );
    const item = itemDe(await q.loadCurationQueue(), "H8c");
    assert.equal(item.status, "PENDING");
    assert.equal(item.metadata.origem, undefined);
  });

  // H9: decisão humana (origem "humano") fica como está, em qualquer caminho de reindex.
  await caso("H9 decisão humana APPROVED não é recalculada pela regra de rejeição (unitário)", async () => {
    escreverRegras([{ id: "rule_painel_lego_rej", action: "AUTO_REJECT", brand: "LEGO" }]);
    escreverFila([{ sku: "H9", title_en: "H9", status: "APPROVED", reason: "manual_dashboard", shopifyStatus: "ACTIVE", metadata: { origem: "humano", approvedAt: DECIDIDO, rejectedAt: null } }]);
    await q.upsertCurationQueueFromRecord(registo("H9"));
    const item = await q.getCurationQueueEntry("H9");
    assert.equal(item.status, "APPROVED");
    assert.equal(item.metadata.origem, "humano");
  });

  await caso("H9b decisão humana REJECTED não é recalculada pela regra de aprovação (unitário)", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([{ sku: "H9b", title_en: "H9b", status: "REJECTED", reason: "manual_dashboard", shopifyStatus: "DRAFT", metadata: { origem: "humano", approvedAt: null, rejectedAt: DECIDIDO } }]);
    await q.upsertCurationQueueFromRecord(registo("H9b"));
    const item = await q.getCurationQueueEntry("H9b");
    assert.equal(item.status, "REJECTED");
    assert.equal(item.metadata.origem, "humano");
  });

  await caso("H9c decisão humana APPROVED não é recalculada pela regra de rejeição (lote)", async () => {
    escreverRegras([{ id: "rule_painel_lego_rej", action: "AUTO_REJECT", brand: "LEGO" }]);
    escreverFila([{ sku: "H9c", title_en: "H9c", status: "APPROVED", reason: "manual_dashboard", shopifyStatus: "ACTIVE", metadata: { origem: "humano", approvedAt: DECIDIDO, rejectedAt: null } }]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("H9c")], { queue: fila });
    assert.equal(itemDe(fila, "H9c").status, "APPROVED");
  });

  await caso("H9d flush do worker não repõe PENDING sobre APPROVED de decisão humana", async () => {
    escreverRegras([]);
    escreverFila([{ sku: "H9d", title_en: "H9d", status: "APPROVED", reason: "manual_dashboard", shopifyStatus: "ACTIVE", metadata: { origem: "humano", approvedAt: DECIDIDO, rejectedAt: null } }]);
    await q.flushCurationQueueItems(
      [{ sku: "H9d", title_en: "H9d", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", metadata: {} }],
      { readAt: Date.parse("2026-10-15T11:00:00.000Z") }
    );
    const item = itemDe(await q.loadCurationQueue(), "H9d");
    assert.equal(item.status, "APPROVED");
    assert.equal(item.metadata.origem, "humano");
  });

  // H10: approveProduct e rejectProduct gravam origem "humano" e seguem a última decisão.
  await caso("H10 approveProduct e rejectProduct gravam origem 'humano' e seguem a última decisão", async () => {
    escreverRegras([]);
    escreverFila([{ sku: "H10", title_en: "H10", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", metadata: {} }]);
    await q.approveProduct("H10");
    let item = await q.getCurationQueueEntry("H10");
    assert.equal(item.status, "APPROVED");
    assert.equal(item.metadata.origem, "humano");
    await q.rejectProduct("H10");
    item = await q.getCurationQueueEntry("H10");
    assert.equal(item.status, "REJECTED");
    assert.equal(item.metadata.origem, "humano");
  });

  // H10r: o rejectProduct de um PENDING sem origem grava origem "humano" por si, sem herdar a do approve.
  await caso("H10r rejectProduct de um PENDING sem origem grava origem 'humano'", async () => {
    escreverRegras([]);
    escreverFila([{ sku: "H10r", title_en: "H10r", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", metadata: {} }]);
    await q.rejectProduct("H10r");
    const item = await q.getCurationQueueEntry("H10r");
    assert.equal(item.status, "REJECTED");
    assert.equal(item.metadata.origem, "humano");
  });

  // H10b-d: os outros caminhos de decisão humana (ação em massa, aprovação em massa do painel e desfazer)
  // também gravam origem "humano".
  await caso("H10b bulkSetQueueStatus grava origem 'humano' em item existente e em SKU novo", async () => {
    escreverRegras([]);
    escreverFila([{ sku: "H10b", title_en: "H10b", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", metadata: {} }]);
    await q.bulkSetQueueStatus(["H10b", "H10b-novo"], "REJECTED");
    const existente = await q.getCurationQueueEntry("H10b");
    assert.equal(existente.status, "REJECTED");
    assert.equal(existente.metadata.origem, "humano");
    const novo = await q.getCurationQueueEntry("H10b-novo");
    assert.equal(novo.status, "REJECTED");
    assert.equal(novo.metadata.origem, "humano");
  });

  await caso("H10c bulkTransitionPending grava origem 'humano' nos PENDING aprovados no painel", async () => {
    escreverRegras([]);
    escreverFila([{ sku: "H10c", title_en: "H10c", status: "PENDING", reason: "pending_review", shopifyStatus: "DRAFT", metadata: {} }]);
    await q.bulkTransitionPending(["H10c"], "APPROVED");
    const item = await q.getCurationQueueEntry("H10c");
    assert.equal(item.status, "APPROVED");
    assert.equal(item.metadata.origem, "humano");
  });

  await caso("H10d desfazer para APPROVED grava origem 'humano', mesmo quando o snapshot era de regra", async () => {
    escreverRegras([]);
    escreverFila([{ sku: "H10d", title_en: "H10d", status: "REJECTED", reason: "manual_dashboard", shopifyStatus: "DRAFT", statusChangedAt: DECIDIDO, metadata: { origem: "humano", rejectedAt: DECIDIDO, approvedAt: null } }]);
    await q.restoreQueueSnapshots([
      { sku: "H10d", status: "APPROVED", shopifyStatus: "ACTIVE", metadata: { smartRule: true, smartAction: "AUTO_APPROVE", origem: "regra", approvedAt: DECIDIDO, rejectedAt: null } },
    ]);
    const item = await q.getCurationQueueEntry("H10d");
    assert.equal(item.status, "APPROVED");
    assert.equal(item.metadata.origem, "humano");
  });

  // H11: PENDING devolvido pelo reset (com statusChangedAt, sem marca de apagado) não é recalculado.
  // O shape é o que reverterTodosPublicados grava no ramo sem apagado (SYNC_ERROR sem id).
  const PENDING_DO_RESET = (sku) => ({
    sku,
    title_en: sku,
    status: "PENDING",
    reason: "pending_review",
    shopifyStatus: "DRAFT",
    statusChangedAt: DECIDIDO,
    metadata: { syncError: null, syncErrorAt: null, shopifyResetAt: DECIDIDO },
  });

  await caso("H11 PENDING devolvido pelo reset não é recalculado pela regra de painel (unitário)", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([PENDING_DO_RESET("H11")]);
    await q.upsertCurationQueueFromRecord(registo("H11"));
    const item = await q.getCurationQueueEntry("H11");
    assert.equal(item.status, "PENDING");
  });

  await caso("H11c PENDING devolvido pelo reset não é recalculado pela regra de painel (lote)", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([PENDING_DO_RESET("H11c")]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("H11c")], { queue: fila });
    assert.equal(itemDe(fila, "H11c").status, "PENDING");
  });

  await caso("H11b item apagado no admin (applyDeletedInAdmin) volta a PENDING e não é recalculado", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    const item = {
      sku: "H11b",
      title_en: "H11b",
      status: "APPROVED",
      reason: "smart_rule:rule_painel_lego",
      shopifyStatus: "ACTIVE",
      metadata: { smartRule: true, smartAction: "AUTO_APPROVE", origem: "regra", approvedAt: DECIDIDO, rejectedAt: null, shopifyProductId: "gid://shopify/Product/9" },
    };
    q.applyDeletedInAdmin(item, DECIDIDO);
    escreverFila([item]);
    await q.upsertCurationQueueFromRecord(registo("H11b"));
    const depois = await q.getCurationQueueEntry("H11b");
    assert.equal(depois.status, "PENDING");
    assert.ok(depois.metadata.deletedInAdmin, "a marca de apagado tem de continuar");
  });

  // H11d: a elite também fica fora de um PENDING com decisão humana (Confirmação 3).
  await caso("H11d elite não rejeita um PENDING devolvido pelo reset (statusChangedAt)", async () => {
    escreverRegras([]);
    escreverFila([PENDING_DO_RESET("H11d")]);
    await q.upsertCurationQueueFromRecord({ ...registo("H11d", "TESTVENDOR"), netPrice: 1 });
    const item = await q.getCurationQueueEntry("H11d");
    assert.equal(item.status, "PENDING");
  });

  // E1: item excluído pela elite (preço líquido abaixo do mínimo, sem marca premium) nasce REJECTED com origem "elite".
  await caso("E1 item rejeitado pela elite nasce REJECTED com origem 'elite' (unitário)", async () => {
    escreverRegras([]);
    escreverFila([]);
    await q.upsertCurationQueueFromRecord({ ...registo("E1", "TESTVENDOR"), netPrice: 1 });
    const item = await q.getCurationQueueEntry("E1");
    assert.equal(item.status, "REJECTED");
    assert.equal(item.metadata.origem, "elite");
    assert.equal(item.metadata.eliteAction, "AUTO_REJECT");
  });

  await caso("E1b item rejeitado pela elite nasce REJECTED com origem 'elite' (lote)", async () => {
    escreverRegras([]);
    escreverFila([]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([{ ...registo("E1b", "TESTVENDOR"), netPrice: 1 }], { queue: fila });
    const item = itemDe(fila, "E1b");
    assert.equal(item.status, "REJECTED");
    assert.equal(item.metadata.origem, "elite");
  });

  fs.rmSync(projectRoot, { recursive: true, force: true });

  if (falhas) {
    console.error(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log("\ncuration-regra-painel: todos os casos passaram");
}

main();
