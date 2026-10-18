#!/usr/bin/env node
/**
 * Resumo dos logs recentes da app, para a tarefa logs_recent (scripts/ci/maintenance.sh).
 *
 * Lê o ficheiro que `flyctl logs --no-tail --json` escreveu: uma entrada por linha. Aceita
 * também texto simples, para o caso de a Fly devolver outro formato. Imprime pares
 * CHAVE=valor só com contagens, categorias, estados e marcas de tempo. Nunca imprime o
 * texto das linhas: o repositório é público (ver maintenance.sh, cabeçalho).
 *
 * Marcas que a app escreve (ASCII, sem dados de loja):
 *   [indexacao] inicio causa=<painel|ciclo|script|desconhecida> modo=<completa|retoma|purga>
 *   [indexacao] fim causa=<...> estado=<concluida|falhou|parada> duracao_s=<n> [indexados=<n>]
 *   [indexacao] worker terminou sem concluir (code=... signal=...)     → reinício do worker
 *   [indexacao] lote-fila duracao_ms=<n> itens=<n>                    → um lote de escrita da fila
 *   [indexacao] recusada (causa=<script|pasta|leitura|ilegivel|sem_pid|publicacao>)  → arranque recusado (PR 5)
 *   [trigger-sync] ciclo saltado: <motivo> | ciclo parado antes da publicação: <motivo> → o ciclo não publicou (PR 5)
 *   [dbDegraded] recusado: <ação>                                      → escrita recusada
 *
 * Uso: node scripts/maintenance/logs-summary.mjs <ficheiro>
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const CAUSAS = ["painel", "ciclo", "script", "desconhecida"];
const INICIO_RE = /\[indexacao\] inicio causa=(\w+) modo=(\w+)/;
const FIM_RE = /\[indexacao\] fim causa=(\w+) estado=(\w+) duracao_s=(\d+)/;
const LOTE_FILA_RE = /\[indexacao\] lote-fila duracao_ms=(\d+) itens=(\d+)/;
// PR 5: arranque recusado pela guarda de atividade (script, pasta, leitura, ilegivel, sem_pid, publicacao).
const RECUSA_INDEXACAO_RE = /\[indexacao\] recusada \(causa=/;
// PR 5: ciclo que não publicou, por script, publicação ou reset, ou por confirmação da indexação.
const CICLO_SALTADO_RE = /\[trigger-sync\] ciclo (saltado|parado antes da publicação)/;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

/** Marca de tempo em ISO, ou null se não for uma data válida. */
export function tsValido(valor) {
  if (valor == null) return null;
  const d = typeof valor === "number" ? new Date(valor) : new Date(String(valor));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Uma entrada por linha não vazia. A linha inteira fica disponível para casar padrões
 * (uma entrada JSON tem o texto da mensagem dentro dela), e a marca de tempo sai do campo
 * `timestamp`/`time`/`ts` se for JSON, ou do primeiro ISO que aparecer no texto.
 * @param {string} texto
 * @returns {{ linha: string, ts: string | null }[]}
 */
export function lerEntradas(texto) {
  const entradas = [];
  for (const linha of texto.split("\n")) {
    if (!linha.trim()) continue;
    let ts = null;
    try {
      const obj = JSON.parse(linha);
      if (obj && typeof obj === "object") ts = tsValido(obj.timestamp ?? obj.time ?? obj.ts);
    } catch {
      /* texto simples: cai no ISO abaixo */
    }
    if (!ts) {
      const m = linha.match(ISO_RE);
      ts = m ? tsValido(m[0]) : null;
    }
    entradas.push({ linha, ts });
  }
  return entradas;
}

/**
 * @param {string} texto conteúdo bruto de `flyctl logs --json`
 * @returns {Record<string, string | number>} pares para imprimir como CHAVE=valor
 */
export function resumirLogs(texto) {
  const entradas = lerEntradas(texto);
  const contagem = (re) => entradas.filter((e) => re.test(e.linha)).length;

  const porCausa = Object.fromEntries(CAUSAS.map((c) => [c, 0]));
  const porEstado = { concluida: 0, falhou: 0, parada: 0 };
  let inicios = 0;
  let ultimoInicio = null;
  let ultimoFim = null;
  let aDecorrer = false;
  // Decisão 6: contagem dos lotes de fila e o máximo da duração observada (ms).
  let lotesFila = 0;
  let loteFilaMaxMs = null;
  // Uma linha sem marca própria (DBG-40) herda a última marca vista antes dela, na ordem do ficheiro.
  let tsAnterior = null;

  for (const e of entradas) {
    const ts = e.ts ?? tsAnterior;
    if (e.ts) tsAnterior = e.ts;
    const ini = e.linha.match(INICIO_RE);
    if (ini) {
      inicios += 1;
      porCausa[CAUSAS.includes(ini[1]) ? ini[1] : "desconhecida"] += 1;
      ultimoInicio = { causa: ini[1], ts };
      aDecorrer = true;
      continue;
    }
    const fim = e.linha.match(FIM_RE);
    if (fim) {
      if (fim[2] in porEstado) porEstado[fim[2]] += 1;
      ultimoFim = { causa: fim[1], estado: fim[2], duracao: fim[3], ts };
      aDecorrer = false;
    }
    const lote = e.linha.match(LOTE_FILA_RE);
    if (lote) {
      lotesFila += 1;
      const ms = Number(lote[1]);
      if (loteFilaMaxMs === null || ms > loteFilaMaxMs) loteFilaMaxMs = ms;
    }
  }

  const tempos = entradas.map((e) => e.ts).filter(Boolean).sort();
  const dbd = contagem(/DbDegradedError/);
  const degr = contagem(/modo degradado/i);

  return {
    LINHAS: entradas.length,
    JANELA_INICIO: tempos[0] ?? "-",
    JANELA_FIM: tempos[tempos.length - 1] ?? "-",
    DBD: dbd,
    MODO_DEGRADADO: degr,
    RECUSAS: contagem(/\[dbDegraded\] recusado: /),
    RECUSAS_FILA: contagem(/\[dbDegraded\] recusado: [^\n]*fila/),
    DB_LOCKED: contagem(/database is locked/i),
    REINICIOS: contagem(/\[indexacao\] worker terminou sem concluir/),
    INDEX_INICIOS: inicios,
    INDEX_CAUSA_PAINEL: porCausa.painel,
    INDEX_CAUSA_CICLO: porCausa.ciclo,
    INDEX_CAUSA_SCRIPT: porCausa.script,
    INDEX_CAUSA_DESCONHECIDA: porCausa.desconhecida,
    INDEX_CONCLUIDAS: porEstado.concluida,
    INDEX_FALHADAS: porEstado.falhou,
    INDEX_RECUSADAS: contagem(RECUSA_INDEXACAO_RE),
    CICLOS_SALTADOS: contagem(CICLO_SALTADO_RE),
    INDEX_PARADAS: porEstado.parada,
    INDEX_A_DECORRER: aDecorrer ? 1 : 0,
    INDEX_ULTIMO_INICIO_TS: ultimoInicio?.ts ?? "-",
    INDEX_ULTIMA_CAUSA: ultimoFim?.causa ?? "-",
    INDEX_ULTIMA_ESTADO: ultimoFim?.estado ?? "-",
    INDEX_ULTIMA_DURACAO_S: ultimoFim?.duracao ?? "-",
    INDEX_ULTIMO_FIM_TS: ultimoFim?.ts ?? "-",
    FILA_LOTES: lotesFila,
    FILA_LOTE_MAX_MS: loteFilaMaxMs ?? "-",
  };
}

function main() {
  const ficheiro = process.argv[2];
  if (!ficheiro) {
    console.error("uso: logs-summary.mjs <ficheiro>");
    process.exit(64);
  }
  let texto;
  try {
    texto = fs.readFileSync(ficheiro, "utf8");
  } catch (err) {
    console.error(`não consegui ler o ficheiro (${err?.code || "erro"})`);
    process.exit(2);
  }
  for (const [chave, valor] of Object.entries(resumirLogs(texto))) {
    console.log(`${chave}=${valor}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
