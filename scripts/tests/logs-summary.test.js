#!/usr/bin/env node
/**
 * logs_recent (relatório de 14/10/2026, secções 9-10) · resumo dos logs da app.
 *
 * Linhas fabricadas, nas duas formas que `flyctl logs --json` pode devolver (JSON por linha e
 * texto simples). Cobre as marcas que a app escreve (indexação, recusas, reinícios,
 * DbDegradedError, database is locked) e a janela temporal que o resumo consegue dar.
 *
 * Uso: node scripts/tests/logs-summary.test.js
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lerEntradas, resumirLogs, tsValido } from "../maintenance/logs-summary.mjs";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/maintenance/logs-summary.mjs");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

/** Uma linha JSON como a Fly a devolve (campos mínimos; o texto vai em `message`). */
function jsonLinha(ts, message) {
  return JSON.stringify({ timestamp: ts, level: "info", message, instance: "abc", region: "mad" });
}

const T = (h, m) => `2026-10-14T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

const LOG_JSON = [
  jsonLinha(T(20, 0), "[indexacao] inicio causa=ciclo modo=completa"),
  jsonLinha(T(20, 5), "[catalog-index-worker:x] [worker-mem] rss=300MB"),
  jsonLinha(T(20, 30), "[indexacao] worker terminou sem concluir (code=null signal=SIGKILL)"),
  jsonLinha(T(20, 31), "[indexacao] fim causa=ciclo estado=falhou duracao_s=1860"),
  jsonLinha(T(21, 0), "[indexacao] inicio causa=painel modo=retoma"),
  jsonLinha(T(21, 10), "[dbDegraded] recusado: escrita na fila de curadoria"),
  jsonLinha(T(21, 11), "[dbDegraded] recusado: escrita na BD (update)"),
  jsonLinha(T(21, 12), "[prisma] publishedStockSync.loadRows falhou (UNKNOWN): database is locked"),
  jsonLinha(T(21, 13), "DbDegradedError: BD em modo degradado (corrupção)"),
  jsonLinha(T(21, 40), "[indexacao] fim causa=painel estado=concluida duracao_s=2400 indexados=25000"),
  jsonLinha(T(22, 0), "[indexacao] inicio causa=script modo=completa"),
].join("\n");

check("JSON: contagens de reinício, recusas, bloqueio e DbDegradedError", () => {
  const r = resumirLogs(LOG_JSON);
  assert.equal(r.LINHAS, 11);
  assert.equal(r.REINICIOS, 1);
  assert.equal(r.RECUSAS, 2);
  assert.equal(r.RECUSAS_FILA, 1, "só a recusa cuja ação fala de fila");
  assert.equal(r.DB_LOCKED, 1);
  assert.equal(r.DBD, 1);
  assert.equal(r.MODO_DEGRADADO, 1, "a linha DbDegradedError tem 'modo degradado'");
});

check("JSON: arranque por causa e fim por estado", () => {
  const r = resumirLogs(LOG_JSON);
  assert.equal(r.INDEX_INICIOS, 3);
  assert.equal(r.INDEX_CAUSA_CICLO, 1);
  assert.equal(r.INDEX_CAUSA_PAINEL, 1);
  assert.equal(r.INDEX_CAUSA_SCRIPT, 1);
  assert.equal(r.INDEX_CAUSA_DESCONHECIDA, 0);
  assert.equal(r.INDEX_FALHADAS, 1);
  assert.equal(r.INDEX_CONCLUIDAS, 1);
  assert.equal(r.INDEX_PARADAS, 0);
});

check("JSON: último fim e duração; corrida ainda aberta é detetada", () => {
  const r = resumirLogs(LOG_JSON);
  assert.equal(r.INDEX_ULTIMA_CAUSA, "painel", "o último fim visto é o da corrida do painel");
  assert.equal(r.INDEX_ULTIMA_ESTADO, "concluida");
  assert.equal(r.INDEX_ULTIMA_DURACAO_S, "2400");
  assert.equal(r.INDEX_A_DECORRER, 1, "o arranque do script às 22:00 não tem fim nas linhas");
  assert.equal(r.INDEX_ULTIMO_INICIO_TS, T(22, 0));
  assert.equal(r.INDEX_ULTIMO_FIM_TS, T(21, 40), "a hora do último fim sai do próprio fim");
});

check("último fim sem marca de tempo própria herda a última marca vista antes dele (DBG-40)", () => {
  const texto = [
    jsonLinha(T(23, 0), "[indexacao] inicio causa=ciclo modo=completa"),
    JSON.stringify({ level: "info", message: "[indexacao] fim causa=ciclo estado=concluida duracao_s=51", instance: "abc" }),
  ].join("\n");
  const r = resumirLogs(texto);
  assert.equal(r.INDEX_ULTIMA_ESTADO, "concluida");
  assert.equal(r.INDEX_ULTIMO_FIM_TS, T(23, 0), "o resumo não pode mostrar '-' quando há marca anterior");
});

check("janela: primeira e última marca de tempo das linhas lidas", () => {
  const r = resumirLogs(LOG_JSON);
  assert.equal(r.JANELA_INICIO, T(20, 0));
  assert.equal(r.JANELA_FIM, T(22, 0));
});

check("texto simples: marca de tempo ISO no texto e mesmas contagens", () => {
  const texto = [
    `${T(9, 0)} [indexacao] inicio causa=ciclo modo=completa`,
    `${T(9, 3)} [indexacao] fim causa=ciclo estado=parada duracao_s=180`,
    `${T(9, 4)} app ok`,
  ].join("\n");
  const r = resumirLogs(texto);
  assert.equal(r.INDEX_PARADAS, 1);
  assert.equal(r.INDEX_A_DECORRER, 0, "parada fecha a corrida");
  assert.equal(r.JANELA_INICIO, T(9, 0));
  assert.equal(r.JANELA_FIM, T(9, 4));
});

check("causa fora da lista fechada conta como desconhecida", () => {
  const r = resumirLogs("[indexacao] inicio causa=outra modo=completa");
  assert.equal(r.INDEX_CAUSA_DESCONHECIDA, 1);
});

check("sem linhas: zeros e janela '-', sem exceção", () => {
  const r = resumirLogs("");
  assert.equal(r.LINHAS, 0);
  assert.equal(r.INDEX_INICIOS, 0);
  assert.equal(r.INDEX_A_DECORRER, 0);
  assert.equal(r.JANELA_INICIO, "-");
  assert.equal(r.INDEX_ULTIMA_CAUSA, "-");
});

check("linha JSON sem marca de tempo válida: entra na contagem, não na janela", () => {
  const [e] = lerEntradas(JSON.stringify({ timestamp: "lixo", message: "[indexacao] fim causa=ciclo estado=concluida duracao_s=5" }));
  assert.equal(e.ts, null);
  const r = resumirLogs(JSON.stringify({ timestamp: "lixo", message: "[indexacao] fim causa=ciclo estado=concluida duracao_s=5" }));
  assert.equal(r.INDEX_CONCLUIDAS, 1);
  assert.equal(r.JANELA_INICIO, "-");
});

// Decisão 6: cada lote de fila regista a duração (lote-fila). O resumo dá a contagem e o máximo.
const LOTES_FILA = [
  jsonLinha(T(20, 0), "[indexacao] lote-fila duracao_ms=120 itens=250"),
  jsonLinha(T(20, 1), "[indexacao] lote-fila duracao_ms=880 itens=250"),
  jsonLinha(T(20, 2), "[indexacao] lote-fila duracao_ms=340 itens=12"),
];

check("lotes de fila: contagem e máximo observado, em JSON", () => {
  const r = resumirLogs(LOTES_FILA.join("\n"));
  assert.equal(r.FILA_LOTES, 3);
  assert.equal(r.FILA_LOTE_MAX_MS, 880, "o máximo, não o último nem a média");
});

check("lotes de fila: texto simples também conta", () => {
  const r = resumirLogs(`${T(9, 0)} [indexacao] lote-fila duracao_ms=55 itens=3`);
  assert.equal(r.FILA_LOTES, 1);
  assert.equal(r.FILA_LOTE_MAX_MS, 55);
});

check("lotes de fila: zero lotes dá 0 e '-', sem exceção", () => {
  for (const texto of [LOG_JSON, ""]) {
    const r = resumirLogs(texto);
    assert.equal(r.FILA_LOTES, 0);
    assert.equal(r.FILA_LOTE_MAX_MS, "-");
  }
});

check("recusas de arranque e ciclos saltados contam-se, em JSON e em texto (PR 5)", () => {
  const texto = [
    `{"timestamp":"${T(9, 0)}","message":"[indexacao] recusada (causa=script): Reindexação por script"}`,
    `${T(9, 1)} [indexacao] recusada (causa=pasta): Pasta de marcadores de atividade não lida`,
    `${T(9, 2)} [trigger-sync] ciclo saltado: script_indexing_running`,
    `${T(9, 3)} [trigger-sync] ciclo parado antes da publicação: indexação em curso`,
  ].join("\n");
  const r = resumirLogs(texto);
  assert.equal(r.INDEX_RECUSADAS, 2, "as duas recusas de arranque");
  assert.equal(r.CICLOS_SALTADOS, 2, "os dois ciclos que não publicaram");
});

check("painel e arranque nulo do ciclo entram nas contagens (rodada 8: causa no painel, linha do ciclo com o prefixo contado)", () => {
  const texto = [
    `${T(10, 0)} [painel] [indexacao] recusada (causa=script): Reindexação por script em curso (pid 4242)`,
    `${T(10, 1)} [painel] [indexacao] recusada (causa=publicacao_ou_reset): há uma publicação ou um reset Shopify em curso.`,
    `${T(10, 2)} [trigger-sync] ciclo parado antes da publicação: indexação não arrancou (publicação ou reset Shopify em curso).`,
  ].join("\n");
  const r = resumirLogs(texto);
  assert.equal(r.INDEX_RECUSADAS, 2, "as duas recusas do painel, com causa=");
  assert.equal(r.CICLOS_SALTADOS, 1, "o arranque nulo do ciclo conta como ciclo que não publicou");
});

check("tsValido aceita ISO e epoch em milissegundos, rejeita o resto", () => {
  assert.equal(tsValido(T(1, 0)), T(1, 0));
  assert.equal(tsValido(0), "1970-01-01T00:00:00.000Z");
  assert.equal(tsValido("lixo"), null);
  assert.equal(tsValido(null), null);
});

check("linha de texto sem marcas não conta nada", () => {
  const r = resumirLogs("app ok\napp ok");
  assert.equal(r.DBD + r.REINICIOS + r.RECUSAS + r.DB_LOCKED + r.INDEX_INICIOS, 0);
});

check("CLI: imprime CHAVE=valor e nenhuma linha da origem (repositório público)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-summary-"));
  const ficheiro = path.join(dir, "logs.txt");
  fs.writeFileSync(ficheiro, LOG_JSON, "utf8");
  const saida = execFileSync(process.execPath, [SCRIPT, ficheiro], { encoding: "utf8" });
  assert.match(saida, /^REINICIOS=1$/m);
  assert.match(saida, /^INDEX_ULTIMA_CAUSA=painel$/m);
  assert.doesNotMatch(saida, /worker-mem|escrita na fila|abc|mad/, "o texto das linhas não pode sair");
});

check("CLI: ficheiro inexistente sai com erro", () => {
  let codigo = 0;
  try {
    execFileSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), "nao-existe-logs-summary.txt")], { stdio: "pipe" });
  } catch (err) {
    codigo = err.status;
  }
  assert.equal(codigo, 2);
});

check("contrato: as marcas que o resumo lê são as que a app escreve", () => {
  // Se alguém renomear uma marca numa ponta, este teste falha antes de o logs_recent ficar cego.
  const indexacao = fs.readFileSync(path.join(ROOT, "lib/importer/catalog/indexingStream.server.js"), "utf8");
  for (const marca of [
    "[indexacao] inicio causa=${causa} modo=${modo}",
    "[indexacao] fim causa=${causa} estado=concluida duracao_s=",
    "[indexacao] fim causa=${causa} estado=falhou duracao_s=",
    "[indexacao] fim causa=${info.causa} estado=parada duracao_s=",
    "[indexacao] worker terminou sem concluir (code=",
    "[indexacao] lote-fila duracao_ms=",
  ]) {
    assert.ok(indexacao.includes(marca), `falta no indexingStream: ${marca}`);
  }
  const degradado = fs.readFileSync(path.join(ROOT, "lib/health/dbDegraded.js"), "utf8");
  assert.ok(degradado.includes("[dbDegraded] recusado: ${action}"), "falta a marca de recusa no dbDegraded");
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nlogs-summary: todos os casos passaram");
