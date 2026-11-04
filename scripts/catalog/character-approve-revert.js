#!/usr/bin/env node
/* eslint-env node */
/**
 * Briefing backend 04/11/2026 — reversão da aprovação por personagem.
 *
 * Devolve ao estado anterior (PENDING) os itens da fila que character-approve.js marcou
 * com metadata.importOrigin = <origem>. Só toca em APPROVED. PUBLISHED, SYNC_ERROR e
 * itens com shopifyProductId ficam como estão e são listados: este script não
 * despublica nada na loja.
 *
 *   node scripts/catalog/character-approve-revert.js                       # dry-run
 *   node scripts/catalog/character-approve-revert.js --execute --confirm-count N
 *
 * FLAGS
 *   --origin <id>   omissão: character-import-2026-11-04
 */
import { loadCurationQueue, mutateCurationQueue } from "../../lib/curation/curationQueue.server.js";
import { recusarSeAtividadeApp } from "../../lib/curation/atividadeApp.js";
import { revertApproval, ORIGIN as DEFAULT_ORIGIN } from "../../lib/importer/catalog/characterApproval.js";

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--origin", "--execute", "--confirm-count"]);
const FLAGS_WITH_VALUE = new Set(["--origin", "--confirm-count"]);
const valOf = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const ORIGIN = valOf("--origin", DEFAULT_ORIGIN);
const EXECUTE = args.includes("--execute");

function die(msg) {
  console.error(`\n${msg}`);
  process.exit(1);
}

function checkArgs() {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      if (i > 0 && FLAGS_WITH_VALUE.has(args[i - 1])) continue;
      die(`Argumento inesperado "${a}".`);
    }
    if (!KNOWN_FLAGS.has(a)) die(`Flag desconhecida "${a}".`);
    if (FLAGS_WITH_VALUE.has(a) && (args[i + 1] == null || args[i + 1].startsWith("--"))) die(`${a} precisa de um valor.`);
  }
  if (EXECUTE && valOf("--confirm-count") == null) die("--execute exige --confirm-count N (o total a reverter do dry-run).");
}

function print(r) {
  console.log(`a reverter (APPROVED → PENDING): ${r.reverted.length}`);
  console.log(`ficam como estão: ${r.kept.length}`);
  const byReason = {};
  for (const k of r.kept) byReason[k.reason] = (byReason[k.reason] || 0) + 1;
  for (const [reason, n] of Object.entries(byReason)) console.log(`  ${String(n).padStart(6)}  ${reason}`);
}

async function main() {
  recusarSeAtividadeApp("character-approve-revert");
  checkArgs();
  console.log(`\n=== character-approve-revert · ${EXECUTE ? "EXECUTE" : "DRY-RUN"} — origem ${ORIGIN} ===\n`);

  // Dry-run sobre uma cópia: a mesma função, sem gravar.
  const copia = structuredClone(await loadCurationQueue());
  const plano = revertApproval(copia, { origin: ORIGIN });
  print(plano);

  if (!EXECUTE) {
    console.log(`\nDRY-RUN — nada escrito. Para reverter: --execute --confirm-count ${plano.reverted.length}\n`);
    return;
  }
  const confirm = Number(valOf("--confirm-count"));
  if (confirm !== plano.reverted.length) die(`PARADO: --confirm-count ${confirm} ≠ ${plano.reverted.length}. Nada escrito.`);

  const res = await mutateCurationQueue((fila) => {
    const r = revertApproval(fila, { origin: ORIGIN });
    return { gravar: r.reverted.length > 0, valor: r };
  });
  console.log(`\nrevertidos: ${res.reverted.length}`);
  for (const k of res.kept) console.log(`  · ${k.sku} — ${k.reason}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n${err?.stack || err?.message || err}`);
  process.exitCode = 1;
});
