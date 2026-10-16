#!/usr/bin/env node
/* eslint-env node */
/**
 * Lente de integridade (bloqueante 1), Decisão 4. O undo decide a marca statusChangedAt pela origem restaurada.
 * Regra, elite e reset devolvem o item às regras e não ganham marca. Humano e sem origem ganham marca, que
 * protege o estado contra o flush do worker (D2).
 *
 * Casos:
 *   U1  Regra: item aprovado por regra, rejeitado à mão e desfeito. Sem marca, o preço desce (PENDING) e
 *       volta a subir (APPROVED por regra). Com a marca reposta (M4), este caso fica vermelho.
 *   U2  Elite: origem restaurada elite, sem marca, e a marca antiga sai.
 *   U3  Reset: origem restaurada reset, sem marca, e a marca antiga sai.
 *   U4  Humano: origem restaurada humano, com marca.
 *   U5  Sem origem: snapshot sem origem, com marca (decisão legada).
 *
 * Usa PROJECT_ROOT e CURATION_DATA_DIR em diretórios temporários. Não toca nos dados reais.
 *
 * Uso: node scripts/tests/curation-undo-marca-origem.test.js
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

// Raiz de projeto temporária, com a configuração que as regras leem. PROJECT_ROOT é lido ao carregar
// config.js, por isso tem de estar definido antes dos imports dinâmicos abaixo.
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "undo-marca-root-"));
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

const REGRA_APROVA_LEGO = { id: "rule_painel_lego", action: "AUTO_APPROVE", brand: "LEGO" };
const MARCA_ANTIGA = "2026-10-01T00:00:00.000Z";

function escreverRegras(regras) {
  fs.writeFileSync(RULES_PATH, JSON.stringify({ version: 1, rules: regras }));
  smart.invalidateSmartRulesCache();
}

function escreverFila(items) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items }));
  q.invalidateCurationMemoryCache();
}

function itemFila(sku, status, metadata, statusChangedAt = null) {
  return {
    sku,
    title_en: sku,
    status,
    reason: "teste_undo",
    shopifyStatus: status === "APPROVED" ? "ACTIVE" : "DRAFT",
    statusChangedAt,
    metadata,
  };
}

/** Registo com preço líquido e marca. Com preço acima de 4 €, LEGO é premium e passa a elite sem problemas. */
const registo = (sku, vendor, netPrice) => ({
  sku,
  title: `Produto ${sku}`,
  vendor,
  categoryMain: "Juguetes",
  netPrice,
  grossPrice: netPrice * 1.2,
  availableQuantity: 5,
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
  await caso("U1 regra: desfeito sem marca; o preço desce (PENDING) e volta a subir (APPROVED por regra)", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([]);
    await q.upsertCurationQueueFromRecord(registo("U1", "LEGO", 20));
    const antes = await q.getCurationQueueEntry("U1");
    assert.equal(antes.status, "APPROVED");
    assert.equal(antes.metadata.origem, "regra", "pré-condição: aprovado por regra");
    const snapshot = { sku: "U1", status: antes.status, shopifyStatus: antes.shopifyStatus, metadata: structuredClone(antes.metadata) };

    await q.rejectProduct("U1", {});
    assert.ok((await q.getCurationQueueEntry("U1")).statusChangedAt, "pré-condição: a rejeição à mão grava marca");

    await q.restoreQueueSnapshots([snapshot]);
    const desfeito = await q.getCurationQueueEntry("U1");
    assert.equal(desfeito.status, "APPROVED");
    assert.equal(desfeito.metadata.origem, "regra");
    assert.equal(desfeito.statusChangedAt, null, "origem regra não grava marca de decisão humana");

    await q.upsertCurationQueueFromRecord(registo("U1", "LEGO", 2));
    assert.equal((await q.getCurationQueueEntry("U1")).status, "PENDING", "o preço desce abaixo do mínimo e a regra deixa de aprovar");

    await q.upsertCurationQueueFromRecord(registo("U1", "LEGO", 20));
    assert.equal((await q.getCurationQueueEntry("U1")).status, "APPROVED", "o preço volta a subir e a regra volta a aprovar");
  });

  await caso("U2 elite: desfeito sem marca, e a marca antiga sai", async () => {
    escreverFila([itemFila("U2", "PENDING", { origem: "humano" }, MARCA_ANTIGA)]);
    await q.restoreQueueSnapshots([{ sku: "U2", status: "REJECTED", metadata: { origem: "elite" } }]);
    const e = await q.getCurationQueueEntry("U2");
    assert.equal(e.status, "REJECTED");
    assert.equal(e.metadata.origem, "elite");
    assert.equal(e.statusChangedAt, null, "origem elite não grava marca e a antiga sai");
  });

  await caso("U3 reset: desfeito sem marca, e a marca antiga sai", async () => {
    escreverFila([itemFila("U3", "PENDING", { origem: "humano" }, MARCA_ANTIGA)]);
    await q.restoreQueueSnapshots([{ sku: "U3", status: "PENDING", metadata: { origem: "reset" } }]);
    const e = await q.getCurationQueueEntry("U3");
    assert.equal(e.metadata.origem, "reset");
    assert.equal(e.statusChangedAt, null, "origem reset devolve o item às regras, sem marca");
  });

  await caso("U4 humano: desfeito com marca, que protege contra o flush do worker", async () => {
    escreverFila([itemFila("U4", "APPROVED", { origem: "regra" }, MARCA_ANTIGA)]);
    await q.restoreQueueSnapshots([{ sku: "U4", status: "REJECTED", metadata: { origem: "humano" } }]);
    const e = await q.getCurationQueueEntry("U4");
    assert.equal(e.status, "REJECTED");
    assert.equal(typeof e.statusChangedAt, "string", "origem humano grava marca");
    assert.notEqual(e.statusChangedAt, MARCA_ANTIGA, "a marca é a do undo, não a antiga");
  });

  await caso("U5 sem origem: desfeito com marca (decisão legada)", async () => {
    escreverFila([itemFila("U5", "APPROVED", { origem: "regra" }, MARCA_ANTIGA)]);
    await q.restoreQueueSnapshots([{ sku: "U5", status: "REJECTED", metadata: {} }]);
    const e = await q.getCurationQueueEntry("U5");
    assert.equal(typeof e.statusChangedAt, "string", "snapshot sem origem grava marca, como antes");
  });

  fs.rmSync(projectRoot, { recursive: true, force: true });

  if (falhas) {
    console.error(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log("\ncuration-undo-marca-origem: todos os casos passaram");
}

await main();
