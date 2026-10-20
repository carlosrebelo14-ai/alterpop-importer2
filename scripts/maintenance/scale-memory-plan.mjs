#!/usr/bin/env node
/**
 * Plano da tarefa scale_memory (Decisão 41): lê o JSON de `flyctl machines list --json` e diz quantas máquinas há
 * e, se houver só uma, a memória atual e o tipo de CPU. Só lê.
 *
 * Saída: linhas SM_<campo>=<valor>. O id completo sai em SM_ID, mas só para o maintenance.sh o passar ao flyctl:
 * nunca se imprime no log nem no resumo. Os outros campos são tokens simples; um valor fora disso sai como "?".
 * Código 0 com um JSON de lista, 2 se não se lê ou não é lista.
 *
 * Uso: flyctl machines list -a <app> --json | node scripts/maintenance/scale-memory-plan.mjs
 */
import { pathToFileURL } from "node:url";

const TOKEN = /^[A-Za-z0-9._:-]{1,40}$/;
const ID = /^[A-Za-z0-9]{1,40}$/;

/** Valor simples para a linha, "nenhum" se faltar, "?" se não for um token simples. */
export function token(valor) {
  if (valor === undefined || valor === null) return "nenhum";
  const texto = String(valor);
  return TOKEN.test(texto) ? texto : "?";
}

/** Plano a partir do texto JSON do flyctl. */
export function plano(texto) {
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    return { linhas: ["SM_ERRO=json_ilegivel"], codigo: 2 };
  }
  if (!Array.isArray(dados)) return { linhas: ["SM_ERRO=formato_inesperado"], codigo: 2 };
  const linhas = [`SM_MAQUINAS=${dados.length}`];
  if (dados.length !== 1) return { linhas, codigo: 0 };
  const m = dados[0] && typeof dados[0] === "object" ? dados[0] : {};
  const id = typeof m.id === "string" && ID.test(m.id) ? m.id : "";
  linhas.push(`SM_ID=${id || "?"}`, `SM_MAQUINA=${id ? id.slice(0, 6) : "?"}`);
  linhas.push(`SM_ESTADO=${token(m.state)}`);
  linhas.push(`SM_MEMORIA_MB=${token(m.config?.guest?.memory_mb ?? m.config?.memory_mb)}`);
  linhas.push(`SM_CPU=${token(m.config?.guest?.cpu_kind)}`, `SM_CPUS=${token(m.config?.guest?.cpus)}`);
  return { linhas, codigo: 0 };
}

async function main() {
  let texto = "";
  for await (const pedaco of process.stdin) texto += pedaco;
  const { linhas, codigo } = plano(texto);
  for (const linha of linhas) console.log(linha);
  process.exit(codigo);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
