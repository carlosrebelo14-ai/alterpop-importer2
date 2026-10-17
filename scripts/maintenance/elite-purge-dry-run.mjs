#!/usr/bin/env node
/* eslint-env node */
// DBG-43. Só leitura: dry-run da purga de elite. Nada é escrito: nem a fila, nem o catálogo, nem o log.
//
// Conta, sem SKU: o que sairia (candidatos, e por estado da fila), o que ficaria retido (por decisão
// humana e por estado da fila). A execução não existe nesta tarefa: a opção execute é recusada pelo
// maintenance.sh e a purga com escrita fica para um PR à parte, depois de revisão do dry-run.
//
// Repositório público: imprime SÓ linhas "EPD: chave=valor" com contagens e estados fixos.
// Nunca SKUs, títulos, motivos em texto livre nem mensagens de erro (podem trazer dados da loja).
//
// Leitura sem efeitos colaterais:
//   - a guarda da BD corre antes de qualquer import do Prisma. Sem BD no volume a tarefa sai com
//     EPD: erro=bd_em_falta, e o Prisma não cria um SQLite vazio (DBG-87);
//   - a fila lê-se diretamente do ficheiro, como em active-vs-queue.mjs. Não se importa
//     curationQueue.server.js, que ao ler um ficheiro em falta pode gravar a flag DB_DEGRADED;
//   - o catálogo lê-se com leiturasDoCatalogoSemEfeitos, que não marca DB_DEGRADED (DBG-86);
//   - a ligação Prisma fecha antes de sair, para o SQLite não deixar -wal e -shm no volume.
//
// Uso (na Fly): node scripts/maintenance/elite-purge-dry-run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diretorioDaFila } from "./active-vs-queue.mjs";
import { recusarSeAtividadeApp } from "../../lib/curation/atividadeApp.js";
import { dbFilePath } from "../../lib/health/dbDegraded.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ESTADOS = ["APPROVED", "PUBLISHED", "PENDING", "REJECTED", "SYNC_ERROR", "sem_entrada", "outro"];
/** Motivos que retêm um item (avaliarPurgaDeEntrada). Prefixo motivo_, para não colidir com retidos_<estado>. */
const MOTIVOS = ["publicado_ou_erro", "apagado_no_admin", "reset", "decisao_humana", "sem_entrada", "sem_origem"];

/**
 * Caminho da BD como o Prisma o abre. Um caminho relativo resolve-se a partir de prisma/, onde está o schema.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function caminhoDaBd(env = process.env) {
  const bruto = dbFilePath(env);
  return path.isAbsolute(bruto) ? bruto : path.resolve(RAIZ, "prisma", bruto);
}

/**
 * Linhas do resumo. Recebe o resultado de purgeEliteCatalog (dry-run) e só lê contagens.
 * @param {{ before: number, candidatos: number, retidos: number, retidosPorMotivo: Record<string, number>, candidatosPorEstado: Record<string, number>, retidosPorEstado: Record<string, number> }} r
 * @returns {string[]}
 */
export function formatarResumoEpd(r) {
  const decisaoHumana = r.retidosPorMotivo?.decisao_humana || 0;
  const linhas = [
    `EPD: catalogo_total=${r.before}`,
    `EPD: candidatos=${r.candidatos}`,
    `EPD: retidos=${r.retidos}`,
    `EPD: retidos_decisao_humana=${decisaoHumana}`,
    `EPD: retidos_outros_motivos=${r.retidos - decisaoHumana}`,
  ];
  for (const estado of ESTADOS) linhas.push(`EPD: sairiam_${estado}=${r.candidatosPorEstado?.[estado] || 0}`);
  for (const estado of ESTADOS) linhas.push(`EPD: retidos_${estado}=${r.retidosPorEstado?.[estado] || 0}`);
  for (const motivo of MOTIVOS) linhas.push(`EPD: motivo_${motivo}=${r.retidosPorMotivo?.[motivo] || 0}`);
  return linhas;
}

/**
 * Corre a tarefa. A purga entra como dependência, para os testes. O dry-run é sempre `executar: false`.
 * @param {{ caminhoFila: string, shop: string, purgar: (shop: string, opcoes: object) => Promise<any> }} args
 * @returns {Promise<{ codigo: string, linhas: string[] }>}
 */
export async function executar({ caminhoFila, shop, purgar }) {
  let itens = null;
  try {
    const dados = JSON.parse(fs.readFileSync(caminhoFila, "utf8"));
    itens = Array.isArray(dados?.items) ? dados.items : null;
  } catch (err) {
    const codigo = err?.code === "ENOENT" ? "fila_em_falta" : "fila_ilegivel";
    return { codigo, linhas: [`EPD: erro=${codigo}`] };
  }
  if (itens === null) return { codigo: "fila_ilegivel", linhas: ["EPD: erro=fila_ilegivel"] };

  let resultado;
  try {
    resultado = await purgar(shop, { executar: false, dependencias: { lerFila: async () => ({ version: 1, items: itens }) } });
  } catch {
    // Sem err.message: pode trazer SKUs ou dados da loja. Uma falha de leitura nunca vira zero.
    return { codigo: "catalogo_falhou", linhas: ["EPD: erro=catalogo_falhou"] };
  }
  return { codigo: "ok", linhas: formatarResumoEpd(resultado) };
}

async function purgarComModuloReal(shop, opcoes) {
  const modulo = await import(pathToFileURL(path.join(RAIZ, "lib", "importer", "curation", "eliteCuration.server.js")).href);
  return modulo.purgeEliteCatalog(shop, { ...opcoes, dependencias: { ...modulo.leiturasDoCatalogoSemEfeitos(), ...opcoes.dependencias } });
}

async function fecharBd() {
  const { prisma } = await import(pathToFileURL(path.join(RAIZ, "lib", "prisma", "prismaSafe.server.js")).href);
  await prisma.$disconnect().catch(() => {});
}

async function main() {
  // Mesma guarda da CLI: com a app a escrever na fila, a leitura não é um retrato. Recusa com código 1 e nada lido.
  recusarSeAtividadeApp("elite-purge-dry-run");
  const shop = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
  // DBG-87: a guarda corre antes de qualquer import do Prisma. Sem BD, nada é criado e a tarefa não diz zero produtos.
  if (!fs.existsSync(caminhoDaBd())) {
    console.log("EPD: erro=bd_em_falta");
    process.exit(1);
  }
  const r = await executar({
    caminhoFila: path.join(diretorioDaFila(), "curation-queue.json"),
    shop,
    purgar: purgarComModuloReal,
  });
  for (const linha of r.linhas) console.log(linha);
  await fecharBd();
  process.exit(r.codigo === "ok" ? 0 : 1);
}

const ehExecucaoDireta = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (ehExecucaoDireta) {
  main().catch(() => {
    console.log("EPD: erro=inesperado");
    process.exit(1);
  });
}
