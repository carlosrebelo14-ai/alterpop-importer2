#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 4 do arquiteto. A elite avalia primeiro, e o portão de preço mínimo vence qualquer regra de painel.
 *
 * O filtro estruturado dá atalho (fastTrack) às marcas premium antes de olhar ao preço. Por isso um item
 * premium abaixo do mínimo passava a elite com action null, e uma regra AUTO_APPROVE aprovava-o. Agora o portão
 * confirma-se à parte, nos dois caminhos da fila (unitário e lote), antes de qualquer regra de painel:
 * - item abaixo do preço mínimo com regra AUTO_APPROVE fica REJECTED, com origem "elite";
 * - item acima do mínimo com a mesma regra continua APPROVED por regra (controlo);
 * - item não-premium abaixo do mínimo fica REJECTED pela elite, como antes (E1).
 *
 * Usa PROJECT_ROOT e CURATION_DATA_DIR em diretórios temporários. Não toca nos dados reais.
 *
 * Uso: node scripts/tests/curation-precedencia-preco-minimo.test.js
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
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "precedencia-preco-root-"));
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
const REGRA_APROVA_TESTVENDOR = { id: "rule_painel_testvendor", action: "AUTO_APPROVE", brand: "TESTVENDOR" };

function escreverRegras(regras) {
  fs.writeFileSync(RULES_PATH, JSON.stringify({ version: 1, rules: regras }));
  smart.invalidateSmartRulesCache();
}

function escreverFila(items) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items }));
  q.invalidateCurationMemoryCache();
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
  // P1: item de marca premium abaixo do preço mínimo, com regra AUTO_APPROVE aplicável. Caminho unitário.
  await caso("P1 premium abaixo do mínimo com regra AUTO_APPROVE fica REJECTED pelo portão, origem elite (unitário)", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([]);
    await q.upsertCurationQueueFromRecord(registo("P1", "LEGO", 2));
    const item = await q.getCurationQueueEntry("P1");
    assert.equal(item.status, "REJECTED", "a regra não pode aprovar abaixo do mínimo");
    assert.equal(item.metadata.origem, "elite");
    assert.equal(item.metadata.smartRule, undefined, "a regra não pode ter decidido o item");
    assert.match(item.reason, /^structured_min_price:/);
  });

  // P1b: o mesmo caso no caminho em lote (aplicarLoteNaFila).
  await caso("P1b premium abaixo do mínimo com regra AUTO_APPROVE fica REJECTED pelo portão, origem elite (lote)", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("P1b", "LEGO", 2)], { queue: fila });
    const item = itemDe(fila, "P1b");
    assert.equal(item.status, "REJECTED");
    assert.equal(item.metadata.origem, "elite");
    assert.equal(item.metadata.smartRule, undefined);
  });

  // P2: controlo. Acima do mínimo, a mesma regra ainda aprova, por regra.
  await caso("P2 controlo: premium acima do mínimo com regra AUTO_APPROVE continua APPROVED por regra (unitário e lote)", async () => {
    escreverRegras([REGRA_APROVA_LEGO]);
    escreverFila([]);
    await q.upsertCurationQueueFromRecord(registo("P2", "LEGO", 20));
    assert.equal((await q.getCurationQueueEntry("P2")).status, "APPROVED");
    assert.equal((await q.getCurationQueueEntry("P2")).metadata.origem, "regra");
    escreverFila([]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("P2b", "LEGO", 20)], { queue: fila });
    assert.equal(itemDe(fila, "P2b").status, "APPROVED");
    assert.equal(itemDe(fila, "P2b").metadata.origem, "regra");
  });

  // P3: não-premium abaixo do mínimo. A elite rejeita antes, como já acontecia (E1). Nenhuma regra o aprova.
  await caso("P3 não-premium abaixo do mínimo com regra AUTO_APPROVE fica REJECTED pela elite (unitário e lote)", async () => {
    escreverRegras([REGRA_APROVA_TESTVENDOR]);
    escreverFila([]);
    await q.upsertCurationQueueFromRecord(registo("P3", "TESTVENDOR", 1));
    const item = await q.getCurationQueueEntry("P3");
    assert.equal(item.status, "REJECTED");
    assert.equal(item.metadata.origem, "elite");
    escreverFila([]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("P3b", "TESTVENDOR", 1)], { queue: fila });
    assert.equal(itemDe(fila, "P3b").status, "REJECTED");
    assert.equal(itemDe(fila, "P3b").metadata.origem, "elite");
  });

  // P4: sem regra de painel, o premium abaixo do mínimo também fica REJECTED pelo portão (mesmo critério de
  // um não-premium, E1). Antes ficava PENDING. Esta é a mudança de comportamento da Decisão 4.
  await caso("P4 premium abaixo do mínimo sem regra de painel fica REJECTED pelo portão, origem elite (unitário e lote)", async () => {
    escreverRegras([]);
    escreverFila([]);
    await q.upsertCurationQueueFromRecord(registo("P4", "LEGO", 2));
    const item = await q.getCurationQueueEntry("P4");
    assert.equal(item.status, "REJECTED");
    assert.equal(item.metadata.origem, "elite");
    escreverFila([]);
    const fila = await q.loadCurationQueue();
    await q.upsertCurationQueueBatchFromRecords([registo("P4b", "LEGO", 2)], { queue: fila });
    assert.equal(itemDe(fila, "P4b").status, "REJECTED");
    assert.equal(itemDe(fila, "P4b").metadata.origem, "elite");
  });

  fs.rmSync(projectRoot, { recursive: true, force: true });

  if (falhas) {
    console.error(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log("\ncuration-precedencia-preco-minimo: todos os casos passaram");
}

main();
