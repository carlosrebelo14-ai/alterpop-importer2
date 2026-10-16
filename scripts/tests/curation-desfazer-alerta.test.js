#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 1 do arquiteto. O desfazer (restoreQueueSnapshots) não mexe em item com alerta de publicado
 * (metadata.alertaPublicadoNaShopify), além dos que têm shopifyProductId, e reporta-os como ignorados
 * na mesma lista e contagem que os outros.
 *
 * - Item REJECTED com alerta e snapshot anterior (APPROVED): fica como está, não é apagado nem alterado,
 *   e aparece em `skipped`.
 * - Controlo: o mesmo snapshot sobre um REJECTED sem alerta e sem id da Shopify é reposto.
 *
 * Usa CURATION_DATA_DIR em diretório temporário (_isolate-curation.js). Não toca nos dados reais.
 *
 * Uso: node scripts/tests/curation-desfazer-alerta.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const QUEUE_PATH = path.join(process.env.CURATION_DATA_DIR, "curation-queue.json");

const q = await import(pathToFileURL(path.join(REPO, "lib/curation/curationQueue.server.js")).href);

const DECIDIDO = "2026-10-14T10:00:00.000Z";
const ALERTA = { shopifyProductId: "gid://shopify/Product/501", em: DECIDIDO };

function escreverFila(items) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items }));
  q.invalidateCurationMemoryCache();
}

const itemDe = async (sku) => q.getCurationQueueEntry(sku);

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

/** Item REJECTED de decisão humana, com o alerta de publicado que o publicador deixa depois de uma rejeição. */
const rejeitadoComAlerta = (sku) => ({
  sku,
  title_en: sku,
  status: "REJECTED",
  reason: "manual_dashboard",
  shopifyStatus: "DRAFT",
  statusChangedAt: DECIDIDO,
  metadata: { origem: "humano", approvedAt: null, rejectedAt: DECIDIDO, alertaPublicadoNaShopify: ALERTA },
});

/** Snapshot anterior à rejeição: o estado e a metadata que o undo repõe se puder. */
const snapshotAprovado = (sku) => ({
  sku,
  status: "APPROVED",
  shopifyStatus: "ACTIVE",
  metadata: { origem: "humano", approvedAt: DECIDIDO, rejectedAt: null },
});

async function main() {
  await caso("D1 desfazer não apaga nem altera um REJECTED com alerta de publicado, e reporta-o como ignorado", async () => {
    escreverFila([rejeitadoComAlerta("D1")]);
    const antes = structuredClone(await itemDe("D1"));
    const { restored, skipped, skippedCount } = await q.restoreQueueSnapshots([snapshotAprovado("D1")]);
    assert.deepEqual(skipped, ["D1"], "o item com alerta tem de ir para skipped");
    assert.equal(skippedCount, 1);
    assert.equal(restored.length, 0, "nenhum item reposto");
    const depois = await itemDe("D1");
    assert.ok(depois, "o item não pode ser apagado");
    assert.deepEqual(depois, antes, "o item com alerta não pode mudar");
    assert.deepEqual(depois.metadata.alertaPublicadoNaShopify, ALERTA, "o alerta tem de sobreviver");
  });

  await caso("D1c controlo: o mesmo snapshot repõe um REJECTED sem alerta nem id da Shopify", async () => {
    const semAlerta = { ...rejeitadoComAlerta("D1c"), metadata: { origem: "humano", approvedAt: null, rejectedAt: DECIDIDO } };
    escreverFila([semAlerta]);
    const { restored, skipped } = await q.restoreQueueSnapshots([snapshotAprovado("D1c")]);
    assert.deepEqual(skipped, [], "sem alerta nem id, o item não é ignorado");
    assert.equal(restored.length, 1);
    assert.equal((await itemDe("D1c")).status, "APPROVED");
  });

  if (falhas) {
    console.error(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log("\ncuration-desfazer-alerta: todos os casos passaram");
}

main();
