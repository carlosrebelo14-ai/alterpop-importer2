#!/usr/bin/env node
/* eslint-env node */
// DBG-50. Só leitura: nenhuma escrita na Shopify, nenhum ficheiro escrito, nenhum estado da fila alterado.
//
// Cruza os produtos ACTIVE da loja (API, sessão offline) com a fila de curadoria do volume
// (curation-queue.json) e conta, por estado da fila, quantos ACTIVE têm entrada APPROVED, PUBLISHED,
// PENDING, REJECTED, outro estado, ou nenhuma entrada. Mostra também os processos node da máquina,
// para ver se corre o sync:daemon.
//
// Repositório público: imprime SÓ contagens (linhas "AVQ: chave=valor") e nomes de scripts node.
// Nunca SKUs, títulos, handles, argumentos de processos nem mensagens de erro (podem trazer dados da loja).
//
// Não importa lib/curation/curationQueue.server.js: esse módulo, ao ler um ficheiro em falta, pode gravar
// a flag DB_DEGRADED. Aqui o ficheiro lê-se diretamente e, se faltar, a tarefa para.
//
// Uso (na Fly): node scripts/maintenance/active-vs-queue.mjs
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ESTADOS_FILA = ["APPROVED", "PUBLISHED", "PENDING", "REJECTED"];
const SCRIPT_RX = /^[A-Za-z0-9._-]+\.(?:mjs|cjs|js)$/;
const FLAG_CODIGO_RX = /^(-e|-p|--eval|--print)(=|$)/;

/**
 * Classifica os SKUs ACTIVE pelo estado da fila. Cada produto cai numa só categoria.
 * Entrada duplicada na fila: vale a primeira, como em curationQueue.server.js (queue.items.find).
 * @param {Array<string|null|undefined>} skusActivos
 * @param {Array<{ sku?: string, status?: string }>} itensDaFila
 */
export function classificarActiveVsQueue(skusActivos, itensDaFila) {
  const estadoPorSku = new Map();
  for (const item of itensDaFila) {
    const sku = item?.sku;
    if (sku === undefined || sku === null || sku === "") continue;
    const chave = String(sku);
    if (!estadoPorSku.has(chave)) estadoPorSku.set(chave, String(item.status ?? ""));
  }
  const c = { total: 0, APPROVED: 0, PUBLISHED: 0, PENDING: 0, REJECTED: 0, outro_estado: 0, sem_entrada: 0, sem_sku: 0 };
  for (const sku of skusActivos) {
    c.total += 1;
    if (sku === undefined || sku === null || sku === "") {
      c.sem_sku += 1;
      continue;
    }
    const chave = String(sku);
    if (!estadoPorSku.has(chave)) {
      c.sem_entrada += 1;
      continue;
    }
    const estado = estadoPorSku.get(chave);
    if (ESTADOS_FILA.includes(estado)) c[estado] += 1;
    else c.outro_estado += 1;
  }
  return c;
}

/**
 * Linhas do resumo. Só contagens e nomes de scripts; `procs` é null quando não se consegue listar.
 * @param {ReturnType<typeof classificarActiveVsQueue>} c
 * @param {string[] | null} procs
 */
export function formatarResumo(c, procs) {
  const linhas = [
    `AVQ: total=${c.total}`,
    `AVQ: APPROVED=${c.APPROVED}`,
    `AVQ: PUBLISHED=${c.PUBLISHED}`,
    `AVQ: PENDING=${c.PENDING}`,
    `AVQ: REJECTED=${c.REJECTED}`,
    `AVQ: outro_estado=${c.outro_estado}`,
    `AVQ: sem_entrada=${c.sem_entrada}`,
    `AVQ: sem_sku=${c.sem_sku}`,
  ];
  if (procs === null) {
    linhas.push("processos: não consegui listar");
  } else {
    linhas.push(`AVQ: processos_node=${procs.length}`);
    for (const nome of procs) linhas.push(`AVQ: proc=${nome}`);
  }
  return linhas;
}

/**
 * Só o nome do script, nunca os argumentos. Código passado com -e/--eval/-p não se mostra, e
 * qualquer nome que não seja um ficheiro .js/.mjs/.cjs simples sai como "(outro)".
 * @param {string[]} args argv sem o binário node
 */
export function nomeDoScript(args) {
  if (args.some((a) => FLAG_CODIGO_RX.test(a))) return "(código inline)";
  const alvo = args.find((a) => a === "-" || !a.startsWith("-"));
  if (alvo === undefined) return "(sem script)";
  if (alvo === "-") return "(stdin)";
  const base = path.basename(alvo);
  return SCRIPT_RX.test(base) ? base : "(outro)";
}

function lerOpcional(ficheiro) {
  try {
    return fs.readFileSync(ficheiro, "utf8");
  } catch {
    return null;
  }
}

/**
 * Nomes dos scripts dos processos node (um por processo, sem o próprio processo desta tarefa).
 * Devolve null se o procDir não existir ou se nenhum processo se conseguir ler (ex.: macOS sem /proc).
 * @param {string} [procDir]
 * @param {number} [ignorarPid]
 */
export function listarProcessosNode(procDir = "/proc", ignorarPid = process.pid) {
  let entradas;
  try {
    entradas = fs.readdirSync(procDir).filter((e) => /^\d+$/.test(e));
  } catch {
    return null;
  }
  const nomes = [];
  let legiveis = 0;
  for (const pid of entradas) {
    const comm = lerOpcional(path.join(procDir, pid, "comm"));
    if (comm === null) continue;
    legiveis += 1;
    if (Number(pid) === ignorarPid) continue;
    if (comm.trim() !== "node") continue;
    const argv = (lerOpcional(path.join(procDir, pid, "cmdline")) || "").split("\0").filter(Boolean);
    nomes.push(nomeDoScript(argv.slice(1)));
  }
  return legiveis > 0 ? nomes : null;
}

/** Mesma resolução de curationQueue.server.js: CURATION_DATA_DIR, depois /app/data, depois server/data. */
export function diretorioDaFila(env = process.env, cwd = process.cwd()) {
  const override = env.CURATION_DATA_DIR?.trim();
  if (override) return override;
  try {
    if (fs.statSync("/app/data").isDirectory()) return "/app/data";
  } catch {
    /* fora do container: segue para o fallback local */
  }
  return path.join(cwd, "server", "data");
}

/**
 * Corre a tarefa. Os dois acessos externos entram como dependências, para os testes.
 * @param {{ caminhoFila: string, lerSkusActivos: () => Promise<Array<string|null>>, procDir?: string, ignorarPid?: number }} args
 * @returns {Promise<{ codigo: string, linhas: string[] }>} codigo "ok" ou um código de erro sem detalhe
 */
export async function executar({ caminhoFila, lerSkusActivos, procDir = "/proc", ignorarPid = process.pid }) {
  let itens = null;
  try {
    const dados = JSON.parse(fs.readFileSync(caminhoFila, "utf8"));
    itens = Array.isArray(dados?.items) ? dados.items : null;
  } catch (err) {
    const codigo = err?.code === "ENOENT" ? "fila_em_falta" : "fila_ilegivel";
    return { codigo, linhas: [`AVQ: erro=${codigo}`] };
  }
  if (itens === null) return { codigo: "fila_ilegivel", linhas: ["AVQ: erro=fila_ilegivel"] };

  let skus;
  try {
    skus = await lerSkusActivos();
  } catch {
    // Sem err.message: a resposta da Shopify pode trazer dados da loja.
    return { codigo: "shopify_falhou", linhas: ["AVQ: erro=shopify_falhou"] };
  }

  const contagens = classificarActiveVsQueue(skus, itens);
  const procs = listarProcessosNode(procDir, ignorarPid);
  return { codigo: "ok", linhas: formatarResumo(contagens, procs) };
}

async function main() {
  const { loadOfflineSessionForShop } = await import("../../lib/session/loadOfflineSessionForShop.server.js");
  const { createShopifyClientFromSession } = await import("../../lib/importer/shopifyClient.js");
  const { fetchProductTags } = await import("../../lib/importer/shopify/productTags.server.js");
  const shop = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

  const r = await executar({
    caminhoFila: path.join(diretorioDaFila(), "curation-queue.json"),
    lerSkusActivos: async () => {
      const client = createShopifyClientFromSession(await loadOfflineSessionForShop(shop));
      const produtos = await fetchProductTags(client, "status:active");
      return produtos.map((p) => p.sku);
    },
  });
  for (const linha of r.linhas) console.log(linha);
  process.exit(r.codigo === "ok" ? 0 : 1);
}

const ehExecucaoDireta = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (ehExecucaoDireta) {
  main().catch((err) => {
    console.log(`AVQ: erro=${err?.code || "inesperado"}`);
    process.exit(1);
  });
}
