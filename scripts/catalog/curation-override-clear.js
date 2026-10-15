#!/usr/bin/env node
/**
 * Tarefa 55 — remove um campo de override manual (`item.metadata.overrides.<field>`)
 * de um SKU na fila de curadoria. `setManualOverride` só sabe ADICIONAR/substituir
 * campos, nunca apagar um — sem este script não havia forma limpa de reverter um
 * override de QA sem editar `curation-queue.json` à mão.
 *
 * DRY-RUN por defeito. `--execute` grava. Não toca no produto na Shopify — depois de
 * limpar o override, o próximo `runApprovedShopifySync` (ou um republish manual) é
 * que aplica o valor normal (cleanTitle/title) na loja.
 *
 * Correr na Fly:
 *   node scripts/catalog/curation-override-clear.js --sku 0030506556343 --field title
 *   node scripts/catalog/curation-override-clear.js --sku 0030506556343 --field title --execute
 */
import { loadCurationQueue, mutateCurationQueue, invalidateCurationMemoryCache } from "../../lib/curation/curationQueue.server.js";
import { recusarSeAtividadeApp } from "../../lib/curation/atividadeApp.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const valOf = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : null);
const SKU = valOf("--sku");
const FIELD = valOf("--field"); // "title" | "price" | "category" | "all"

async function main() {
  recusarSeAtividadeApp("curation-override-clear");
  if (!SKU || !FIELD) {
    console.error("uso: node scripts/catalog/curation-override-clear.js --sku <sku> --field <title|price|category|all> [--execute]");
    process.exit(1);
  }

  const queue = await loadCurationQueue();
  const item = queue.items.find((i) => i.sku === SKU);
  if (!item) {
    console.error(`SKU ${SKU} não existe na fila.`);
    process.exit(1);
  }

  const overrides = item.metadata?.overrides || {};
  if (!Object.keys(overrides).length) {
    console.log(`SKU ${SKU} não tem overrides — nada a fazer.`);
    return;
  }

  console.log(`=== curation-override-clear (${SKU})${EXECUTE ? "" : " · DRY-RUN"} ===`);
  console.log(`overrides atuais: ${JSON.stringify(overrides)}`);

  const nextOverrides = { ...overrides };
  if (FIELD === "all") {
    for (const k of Object.keys(nextOverrides)) delete nextOverrides[k];
  } else {
    if (!(FIELD in nextOverrides)) {
      console.log(`campo "${FIELD}" já não está definido — nada a fazer.`);
      return;
    }
    delete nextOverrides[FIELD];
  }

  console.log(`overrides depois: ${JSON.stringify(nextOverrides)}`);

  if (!EXECUTE) {
    console.log(`\nDRY-RUN — nada escrito. Corre com --execute.`);
    return;
  }

  // Decisão 35 (D3/D7): a escrita passa pelo lock da fila, sobre a fila lida de novo.
  await mutateCurationQueue((fila) => {
    const alvo = fila.items.find((i) => i.sku === SKU);
    if (!alvo) throw new Error(`SKU ${SKU} deixou de existir na fila. Nada foi gravado.`);
    alvo.metadata = {
      ...alvo.metadata,
      overrides: nextOverrides,
      overridesUpdatedAt: new Date().toISOString(),
    };
    return { gravar: true, valor: undefined };
  });
  invalidateCurationMemoryCache();
  console.log(`\n✓ override "${FIELD}" removido de ${SKU}.`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
