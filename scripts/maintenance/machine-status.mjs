#!/usr/bin/env node
/**
 * Estado das máquinas da app na Fly, a partir do JSON de `flyctl machines list --json` (tarefa machine_status).
 *
 * Imprime só linhas MS: com contagens, estados, região, memória configurada e o último evento de saída (código,
 * sinal e OOM). Nunca imprime o id completo de uma máquina, nem o JSON. Um valor fora de token simples sai como "?".
 *
 * Se o último evento de saída não traz os campos que a leitura espera, imprime só os NOMES das chaves desse evento
 * (sem valores). Assim o esquema real fica visível na primeira corrida, sem adivinhar. Os nomes esperados
 * (Machines API, evento de saída) são request.exit_event.exit_code, guest_signal e oom_killed.
 *
 * Uso: flyctl machines list -a <app> --json | node scripts/maintenance/machine-status.mjs
 * Código: 0 com JSON de máquinas; 2 se o JSON não se lê ou não é uma lista.
 */
import { pathToFileURL } from "node:url";

const TOKEN = /^[A-Za-z0-9._:-]{1,40}$/;
const NOME_DE_CHAVE = /^[A-Za-z0-9_]{1,40}$/;
const MAX_CHAVES = 12;

/** Valor simples para a linha, ou "?" se não for um token simples (nunca entra texto livre). */
export function token(valor) {
  if (valor === undefined || valor === null) return "nenhum";
  const texto = String(valor);
  return TOKEN.test(texto) ? texto : "?";
}

/** Os seis primeiros caracteres do id. O id completo não sai do script. */
export function idCurto(id) {
  return typeof id === "string" && id.length > 0 ? token(id.slice(0, 6)) : "?";
}

/** Milissegundos de um timestamp, ou 0 se não for uma data válida. */
function tempo(valor) {
  const ms = Date.parse(valor);
  return Number.isFinite(ms) ? ms : 0;
}

/** Último evento de saída de uma máquina, ou null. É de saída se tem type "exit" ou se traz request.exit_event. */
export function ultimaSaida(eventos) {
  if (!Array.isArray(eventos)) return null;
  const saidas = eventos.filter((e) => e && typeof e === "object" && (e.type === "exit" || e.request?.exit_event));
  if (saidas.length === 0) return null;
  saidas.sort((a, b) => tempo(a.timestamp) - tempo(b.timestamp));
  return saidas[saidas.length - 1];
}

/**
 * Instante em ISO (UTC). A Machines API devolve número em milissegundos; aceita também texto de data.
 * Sem data válida, sai o valor como token simples.
 */
export function instante(valor) {
  if (typeof valor === "number" && Number.isFinite(valor)) {
    const data = new Date(valor);
    return Number.isNaN(data.getTime()) ? "?" : data.toISOString();
  }
  if (typeof valor === "string") {
    const ms = Date.parse(valor);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return token(valor);
}

/** Nomes das chaves de um objeto, só nomes simples, limitados. Nunca os valores. */
export function nomesDeChaves(objeto) {
  if (!objeto || typeof objeto !== "object") return "nenhum";
  const nomes = Object.keys(objeto).filter((k) => NOME_DE_CHAVE.test(k)).slice(0, MAX_CHAVES);
  return nomes.length > 0 ? nomes.join("|") : "nenhum";
}

/** Uma linha MS: por máquina. */
export function linhaDaMaquina(maquina) {
  const m = maquina && typeof maquina === "object" ? maquina : {};
  const partes = [
    `maquina=${idCurto(m.id)}`,
    `estado=${token(m.state)}`,
    `regiao=${token(m.region)}`,
    `memoria_mb=${token(m.config?.guest?.memory_mb ?? m.config?.memory_mb)}`,
    `cpu_kind=${token(m.config?.guest?.cpu_kind)}`,
    `cpus=${token(m.config?.guest?.cpus)}`,
  ];
  const saida = ultimaSaida(m.events);
  const exitEvent = saida?.request?.exit_event;
  if (!saida) {
    partes.push("saida=nenhuma");
  } else if (!exitEvent || typeof exitEvent !== "object") {
    partes.push("saida=evento_sem_campos", `chaves=${nomesDeChaves(saida)}`, `chaves_request=${nomesDeChaves(saida.request)}`);
  } else {
    const codigo = exitEvent.exit_code ?? exitEvent.guest_exit_code;
    const oom = exitEvent.oom_killed;
    partes.push(
      `saida=ok`,
      `codigo=${token(codigo)}`,
      `sinal=${token(exitEvent.guest_signal ?? exitEvent.signal)}`,
      `oom=${oom === true ? "sim" : oom === false ? "nao" : "?"}`,
      `quando=${instante(saida.timestamp)}`
    );
  }
  return `MS: ${partes.join(" ")}`;
}

/** Resumo de um texto JSON do flyctl: linhas MS: e código de saída. */
export function resumir(texto) {
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    return { linhas: ["MS: erro=json_ilegivel"], codigo: 2 };
  }
  if (!Array.isArray(dados)) return { linhas: ["MS: erro=formato_inesperado"], codigo: 2 };
  return { linhas: [`MS: maquinas=${dados.length}`, ...dados.map(linhaDaMaquina)], codigo: 0 };
}

async function main() {
  let texto = "";
  for await (const pedaco of process.stdin) texto += pedaco;
  const { linhas, codigo } = resumir(texto);
  for (const linha of linhas) console.log(linha);
  process.exit(codigo);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
