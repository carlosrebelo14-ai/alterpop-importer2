/* eslint-env node */
/**
 * Estado da última indexação do catálogo, para a tarefa indexing_status. Só lê, nunca escreve.
 *
 * Lê o mesmo ficheiro que o V16 (<data>/catalog-index/<shop>-rebuild-status.json, ver
 * catalogRebuildStatus.server.js) e imprime UMA linha:
 *   IS: state=… startedAt=… finishedAt=… totalRows=… checkpointScanned=… totalRejected=… erro=… erro_tamanho=…
 *       falha_em=… falha_causa=… falha_classe=…   (última falha: data, causa e classe; nunca o texto)
 *
 * O repositório é público. O texto de `error` nunca sai: a causa vai como classe de uma lista fechada, e só
 * se diz o tamanho. Cada valor que não seja um token simples vira "?", para que nada do ficheiro entre no
 * log como texto livre.
 *
 * Sem o ficheiro: state=sem_ficheiro, exit 0. JSON ilegível ou que não é objeto: exit 2, sem conteúdo.
 * Só node:fs e node:path, como check-no-indexing.mjs, para correr na Fly sem deploy.
 *
 * Uso: node indexing-status.mjs [--shop <shop>] [--data-dir <dir>]
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

/** Lista fechada. A ordem importa: a primeira que bater ganha. Tudo o que não bate é "outra". */
const CLASSES = [
  [/^\[fila\]|CURATION_QUEUE_LOCK/, "fila"],
  [/^worker process exited/, "worker_saiu"],
  [/^worker process killed/, "worker_morto"],
  [/^A indexação não arrancou/, "marcador"],
  [/estado de indexação ilegível/, "ilegivel"],
];

function classeDoErro(erro) {
  if (erro === null || erro === undefined || erro === "") return "nenhum";
  const texto = String(erro);
  const encontrada = CLASSES.find(([re]) => re.test(texto));
  return encontrada ? encontrada[1] : "outra";
}

/** Um token simples passa. Qualquer outra coisa (espaços, aspas, texto livre) vira "?". */
function token(valor, re = /^[A-Za-z0-9:._+-]{1,40}$/) {
  if (valor === null || valor === undefined) return "null";
  const s = String(valor);
  return re.test(s) ? s : "?";
}

/** Causas de falha, em lista fechada. Cópia de CAUSAS_FALHA em lib/importer/catalog/falhaIndexacao.js (teste pina). */
const CAUSAS = ["worker_saiu", "worker_morto", "erro_worker", "erro_pai", "marcador", "estado_nao_gravado", "erro_script"];

/** Campo do lastFailure. Sem lastFailure, "nenhuma". O texto de error nunca passa por aqui. */
function campoDaFalha(falha, campo, re) {
  if (!falha || typeof falha !== "object") return "nenhuma";
  return token(falha[campo], re);
}

function causaDaFalha(falha) {
  if (!falha || typeof falha !== "object") return "nenhuma";
  return CAUSAS.includes(falha.causa) ? falha.causa : "?";
}

function linha(campos) {
  const partes = [
    `state=${token(campos.state)}`,
    `startedAt=${token(campos.startedAt)}`,
    `finishedAt=${token(campos.finishedAt)}`,
    `totalRows=${token(campos.totalRows, /^\d{1,12}$/)}`,
    `checkpointScanned=${token(campos.checkpointScanned, /^\d{1,12}$/)}`,
    `totalRejected=${token(campos.totalRejected, /^\d{1,12}$/)}`,
    `erro=${classeDoErro(campos.error)}`,
    `erro_tamanho=${campos.error ? String(campos.error).length : 0}`,
    `falha_em=${campoDaFalha(campos.lastFailure, "at", /^[0-9TZ:.+-]{1,40}$/)}`,
    `falha_causa=${causaDaFalha(campos.lastFailure)}`,
    `falha_classe=${campos.lastFailure && typeof campos.lastFailure === "object" ? classeDoErro(campos.lastFailure.error) : "nenhuma"}`,
  ];
  return `IS: ${partes.join(" ")}`;
}

let raw;
try {
  raw = fs.readFileSync(file, "utf8");
} catch (err) {
  if (err?.code === "ENOENT") {
    console.log(linha({ state: "sem_ficheiro" }));
    process.exit(0);
  }
  console.error("IS: erro_leitura=sim");
  process.exit(2);
}

let status;
try {
  status = JSON.parse(raw);
} catch {
  console.error("IS: erro_leitura=json");
  process.exit(2);
}
if (!status || typeof status !== "object" || Array.isArray(status)) {
  console.error("IS: erro_leitura=nao_objeto");
  process.exit(2);
}

console.log(linha({ ...status, state: status.state ?? "idle" }));
