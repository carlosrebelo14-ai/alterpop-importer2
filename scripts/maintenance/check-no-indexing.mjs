/* eslint-env node */
/**
 * Falha (exit 1) se houver uma indexação do catálogo a decorrer. Só lê, nunca escreve.
 *
 * Corre na Fly, enviado pelo scripts/ci/maintenance.sh (probe_indexing) antes do catalog_health, do db_push
 * e da espera antes do deploy (esperar_indexacao):
 *   B64=$(base64 -w0 scripts/maintenance/check-no-indexing.mjs)
 *   flyctl ssh console -a alterpop-importer-app -C "sh -lc 'cd /app && echo $B64 | base64 -d | node --input-type=module -'"
 *
 * Lê o mesmo ficheiro que o V16 do catalog:health
 * (<data>/catalog-index/<shop>-rebuild-status.json, ver catalogRebuildStatus.server.js) e
 * aplica o mesmo critério de "a decorrer" (state "running" ou indexing true). Não importa
 * Prisma nem código da app: tem de poder correr sem tocar no SQLite que o db:push vai alterar.
 *
 * Sem o ficheiro (ENOENT) nunca houve indexação neste volume: passa. Qualquer outra falha de
 * leitura ou JSON ilegível falha (exit 2): um erro de leitura nunca vira "não há indexação"
 * (Decisão 30).
 *
 * Uso: node check-no-indexing.mjs [--shop <shop>] [--data-dir <dir>]
 * Defaults: SHOPIFY_SHOP_URL ou jyr17t-wr.myshopify.com (como o V16); <cwd>/data.
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const shop = opt("--shop") || process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const dataDir = opt("--data-dir") || path.join(process.cwd(), "data");
const file = path.join(dataDir, "catalog-index", `${shop.replace(/\//g, "_")}-rebuild-status.json`);

let raw;
try {
  raw = fs.readFileSync(file, "utf8");
} catch (err) {
  if (err?.code === "ENOENT") {
    console.log(`[check-no-indexing] sem ficheiro de estado (${file}): nenhuma indexação registada.`);
    process.exit(0);
  }
  console.error(`[check-no-indexing] não consegui ler ${file}: ${err?.message}. A falhar por segurança.`);
  process.exit(2);
}

let status;
try {
  status = JSON.parse(raw);
} catch (err) {
  console.error(`[check-no-indexing] ${file} não é JSON válido: ${err?.message}. A falhar por segurança.`);
  process.exit(2);
}

// DBG-154: um objeto sem state nem indexing não diz nada sobre a indexação. Passar com 0 seria um fail-open
// no portão do db:push e do deploy. Sai com 2, como o JSON ilegível.
if (!status || typeof status !== "object" || Array.isArray(status) || (status.state === undefined && status.indexing === undefined)) {
  console.error(`[check-no-indexing] ${file} não tem state nem indexing. A falhar por segurança.`);
  process.exit(2);
}

const running = status.state === "running" || status.indexing === true;
if (!running) {
  console.log(`[check-no-indexing] estado "${status?.state ?? "idle"}", indexing=${status?.indexing === true}: nenhuma indexação a decorrer.`);
  process.exit(0);
}

const ageMin = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000);
console.error("[check-no-indexing] INDEXAÇÃO A DECORRER. O db:push não corre (Decisão 28).");
console.error(
  `  state=${status.state} indexing=${status.indexing} startedAt=${status.startedAt ?? "?"} ` +
    `scanned=${status.scanned ?? "?"}/${status.totalRows ?? "?"} ficheiro atualizado há ${ageMin} min`
);
if (ageMin > 30) {
  console.error(
    "  O ficheiro não muda há mais de 30 min: pode ser um estado preso de um processo morto. " +
      "Confirma na Fly antes de repetir; este check não o limpa."
  );
}
process.exit(1);
