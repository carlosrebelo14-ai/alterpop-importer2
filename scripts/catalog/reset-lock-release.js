#!/usr/bin/env node
/**
 * Liberta o trinco de shopify-reset quando está órfão — nenhum processo vivo a
 * escrevê-lo, idade muito acima de qualquer reset real (ver diagnóstico 24/09,
 * trinco de 09/09 preso em "deleting" 8/5440 há 15 dias).
 *
 * NÃO apaga produtos, NÃO retoma o reset de 5440 e NÃO reabre nada — só reescreve
 * o ficheiro de estado para "failed" com failureReason "orphaned", depois de
 * arquivar o ficheiro anterior (nunca apagado). Este script não importa
 * runShopifyCatalogReset nem startShopifyCatalogResetInBackground: reabrir o reset
 * a partir daqui é estruturalmente impossível.
 *
 * Duas travas de segurança, ambas obrigatórias para --execute:
 *   - state tem de estar em running/listing/deleting (nada a libertar caso
 *     contrário)
 *   - idade tem de exceder --min-age-minutes (default 10) — protege contra
 *     libertar um trinco que ainda pode ser um reset real em curso
 *
 * DRY-RUN por defeito (só lê e mostra o que faria). `--execute` escreve.
 *
 * Corre na Fly (é lá que está /app/data):
 *   flyctl ssh console -a alterpop-importer-app \
 *     -C "node scripts/catalog/reset-lock-release.js"              # dry-run
 *   flyctl ssh console -a alterpop-importer-app \
 *     -C "node scripts/catalog/reset-lock-release.js --execute"
 */
import fs from "fs/promises";
import path from "path";
import {
  readShopifyResetStatus,
  writeShopifyResetStatus,
  isShopifyResetRunning,
} from "../../lib/importer/shopify/shopifyResetJob.server.js";
import { getDefaultConfig } from "../../lib/importer/config.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const MIN_AGE_MINUTES = Number(
  (args.indexOf("--min-age-minutes") >= 0 && args[args.indexOf("--min-age-minutes") + 1]) || 10
);

const RUNNING_STATES = new Set(["running", "listing", "deleting"]);

/** Mesmo caminho que shopifyResetJob.server.js usa internamente (statusPath não é exportado). */
function statusPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "shopify-reset",
    `${shop.replace(/\//g, "_")}-status.json`
  );
}

async function archiveCurrentFile(shop) {
  const src = statusPath(shop);
  const raw = await fs.readFile(src, "utf8");
  const dateSuffix = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = src.replace(/-status\.json$/, `-status.${dateSuffix}.json`);
  await fs.writeFile(dest, raw, "utf8");
  return dest;
}

async function main() {
  console.log(`=== reset-lock-release (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===`);

  const status = await readShopifyResetStatus(SHOP);
  const ageMinutes = status.startedAt
    ? (Date.now() - new Date(status.startedAt).getTime()) / 60000
    : null;

  console.log(`jobId: ${status.jobId ?? "(nenhum)"}`);
  console.log(`state: ${status.state}`);
  console.log(`startedAt: ${status.startedAt ?? "(nunca)"}`);
  console.log(
    `idade: ${ageMinutes == null ? "n/d" : `${ageMinutes.toFixed(1)} min (${(ageMinutes / 1440).toFixed(1)} dias)`}`
  );
  console.log(`processed/total: ${status.processed}/${status.total} · deleted: ${status.deleted}`);
  console.log(`currentTitle: ${status.currentTitle ?? "(nenhum)"}`);

  if (!RUNNING_STATES.has(status.state)) {
    console.log(`\nEstado atual "${status.state}" não é running/listing/deleting — nada a libertar.`);
    return;
  }

  if (ageMinutes == null || ageMinutes < MIN_AGE_MINUTES) {
    console.log(
      `\n⚠️  Idade (${ageMinutes == null ? "desconhecida" : ageMinutes.toFixed(1) + " min"}) abaixo do ` +
        `limiar de segurança (--min-age-minutes=${MIN_AGE_MINUTES}). Recusa libertar — pode ser um reset real em curso.`
    );
    process.exit(1);
  }

  const explanation =
    `Trinco libertado manualmente (reset-lock-release.js) — órfão confirmado: sem processo ` +
    `vivo (ps no contentor), idade ${ageMinutes.toFixed(1)} min no momento da libertação. ` +
    `Reset original nunca retomado.`;

  if (!EXECUTE) {
    // Mesmo padrão de nome que archiveCurrentFile() usaria — calculado agora, só para
    // pré-visualização. O --execute real usa a hora exata desse momento, não esta.
    const previewDest = statusPath(SHOP).replace(
      /-status\.json$/,
      `-status.${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    console.log(`\nDRY-RUN — nada escrito. Corre com --execute para libertar.`);
    console.log(`Escreveria: state="failed", failureReason="orphaned", finishedAt=<agora>`);
    console.log(`Arquivaria o ficheiro atual em (exemplo, hora real será a do --execute):`);
    console.log(`  ${previewDest}`);
    console.log(`Reset retomado: não — este script nunca importa runShopifyCatalogReset.`);
    return;
  }

  const archivedPath = await archiveCurrentFile(SHOP);
  console.log(`\nFicheiro anterior arquivado em: ${archivedPath}`);

  const finishedAt = new Date().toISOString();
  await writeShopifyResetStatus(SHOP, {
    state: "failed",
    failureReason: "orphaned",
    error: explanation,
    currentTitle: null,
    finishedAt,
    releasedManually: true,
    releasedAt: finishedAt,
  });

  const stillRunning = await isShopifyResetRunning(SHOP);
  console.log(`\nTrinco libertado. isShopifyResetRunning(${SHOP}) agora: ${stillRunning}`);
  if (stillRunning) {
    console.log(`⚠️  Continua a devolver true — algo não bateu certo, investigar antes de publicar.`);
    process.exit(1);
  }
  console.log(`✅ Publish desbloqueado.`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
