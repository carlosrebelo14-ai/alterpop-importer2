#!/usr/bin/env node
/* eslint-env node */
/**
 * Processo filho de scripts/tests/curation-queue-cross-process.test.js. Não é um teste.
 *
 * Recebe em argv[2] um JSON com a operação e corre-a sobre a fila de curadoria a partir de outro
 * processo Node (fork real). O diretório da fila vem do pai (dataDir). Por isso este ficheiro não
 * importa _isolate-curation.js: esse módulo criaria outro diretório temporário.
 *
 * Protocolo: se waitGo, envia { type: "ready" } depois de importar a fila e espera { type: "go" }.
 * Depois corre a operação e envia { type: "done" } ou { type: "error", message }. Sai sempre.
 */
const payload = JSON.parse(process.argv[2] || "{}");
process.env.CURATION_DATA_DIR = payload.dataDir;
process.env.DATABASE_URL = payload.databaseUrl;

const q = await import(payload.queueModule);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function terminar(mensagem) {
  const codigo = mensagem.type === "done" ? 0 : 1;
  if (process.send) process.send(mensagem, () => process.exit(codigo));
  else process.exit(codigo);
}

function esperarGo() {
  return new Promise((resolve) => {
    const aoReceber = (mensagem) => {
      if (mensagem?.type === "go") {
        process.off("message", aoReceber);
        resolve();
      }
    };
    process.on("message", aoReceber);
  });
}

async function correr() {
  switch (payload.op) {
    case "aprovar-lote":
      for (const sku of payload.skus) {
        await q.approveProduct(sku);
        await sleep(payload.pauseMs);
      }
      return;
    case "flush-lote":
      for (const item of payload.items) {
        await q.flushCurationQueueItems([item]);
        await sleep(payload.pauseMs);
      }
      return;
    case "approveProduct":
      await q.approveProduct(payload.sku);
      return;
    case "rejectProduct":
      await q.rejectProduct(payload.sku);
      return;
    case "setManualOverride":
      await q.setManualOverride(payload.sku, payload.overrides, payload.meta);
      return;
    case "bulkSetMarginPct":
      await q.bulkSetMarginPct(payload.skus, payload.marginPct);
      return;
    default:
      throw new Error(`operação desconhecida: ${payload.op}`);
  }
}

try {
  if (payload.waitGo) {
    process.send({ type: "ready" });
    await esperarGo();
  }
  await correr();
  terminar({ type: "done" });
} catch (err) {
  terminar({ type: "error", message: String(err?.message || err) });
}
