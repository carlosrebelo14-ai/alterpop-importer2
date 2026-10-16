#!/usr/bin/env node
/* eslint-env node */
/**
 * Processo filho de scripts/tests/curation-queue-file-lock.test.js. Não é um teste.
 *
 * Simula um script que escreve a fila diretamente, como os de scripts/catalog/. Por isso não chama
 * usarEscritorDoPrincipal: as escritas tomam o lock de ficheiro deste processo. O diretório da fila
 * vem do pai (dataDir), e o módulo é carregado depois de o ambiente estar definido.
 *
 * Recebe em argv[2] um JSON com:
 *   op      "aprovar": approveProduct para cada SKU de skus.
 *           "segurar": mutateCurationQueue que espera holdMs sem gravar. Envia { type: "dentro" } ao
 *                      entrar no lock e { type: "fim", em } antes de o devolver.
 *   waitGo  se true, envia { type: "ready" } depois de importar a fila e espera { type: "go" }.
 *
 * Envia { type: "done" } ou { type: "error", message } e sai com 0 ou 1.
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
    case "aprovar":
      for (const sku of payload.skus) await q.approveProduct(sku);
      return;
    case "segurar":
      await q.mutateCurationQueue(async () => {
        process.send({ type: "dentro" });
        await sleep(payload.holdMs);
        process.send({ type: "fim", em: Date.now() });
        return { gravar: false, valor: undefined };
      });
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
