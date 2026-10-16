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
//   - a fila lê-se diretamente do ficheiro, como em active-vs-queue.mjs. Não se importa
//     curationQueue.server.js, que ao ler um ficheiro em falta pode gravar a flag DB_DEGRADED;
//   - o catálogo lê-se pelas leituras por omissão da purga, diretas, sem safePrisma (DBG-86, DBG-87);
//   - sem BD no volume, a tarefa sai com erro antes de ligar. Senão o Prisma criaria um SQLite vazio
//     e a tarefa diria "0 produtos".
//
// Uso (na Fly): node scripts/maintenance/elite-purge-dry-run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diretorioDaFila } from "./active-vs-queue.mjs";
import { recusarSeAtividadeApp } from "../../lib/curation/atividadeApp.js";
import { dbFilePath } from "../../lib/health/dbDegraded.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ESTADOS = ["APPROVED", "PUBLISHED", "PENDING", "REJECTED", "SYNC_ERROR", "sem_entrada", "outro"];

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
  return modulo.purgeEliteCatalog(shop, opcoes);
}

async function main() {
  // Mesma guarda da CLI: com a app a escrever na fila, a leitura não é um retrato. Recusa com código 1 e nada lido.
  recusarSeAtividadeApp("elite-purge-dry-run");
  const shop = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
  // DBG-87: sem BD no volume, o Prisma criaria um SQLite vazio e a tarefa diria zero produtos. Recusa antes de ligar.
  if (!fs.existsSync(dbFilePath())) {
    console.log("EPD: erro=bd_em_falta");
    process.exit(1);
  }
  const r = await executar({
    caminhoFila: path.join(diretorioDaFila(), "curation-queue.json"),
    shop,
    purgar: purgarComModuloReal,
  });
  for (const linha of r.linhas) console.log(linha);
  // Fecha a ligação antes de sair: sem isto, o SQLite deixa os ficheiros -wal e -shm no volume.
  await prisma.$disconnect().catch(() => {});
  process.exit(r.codigo === "ok" ? 0 : 1);
}

const ehExecucaoDireta = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (ehExecucaoDireta) {
  main().catch(() => {
    console.log("EPD: erro=inesperado");
    process.exit(1);
  });
}
