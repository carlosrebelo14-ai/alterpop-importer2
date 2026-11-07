#!/usr/bin/env node
/**
 * Briefing 06/11/2026, PR C, R4. O --aceitar-base só escreve o health-gate-state.json.
 *  - comportamento: gravarReferencia com aceitarNovaBase e gravarSemEstado, numa pasta com outros ficheiros;
 *  - estática: o pre-pilot-verify.js não tem nenhuma escrita própria e só chama as duas funções de gravação do estado;
 *  - o caminho de execute do maintenance.sh corre um único comando remoto, o do --aceitar-base.
 * Uso: node scripts/tests/health-accept-base-writes.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gravarReferencia, gravarSemEstado, carregarEstado } from "../../lib/health/gateState.server.js";
import { semComentarios } from "./_sem-comentarios.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}

async function pastaComVizinhos() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aceitar-base-"));
  const vizinhos = { "curation-queue.json": '{"items":[1,2,3]}', "settings.json": '{"margem":40}', "dev.sqlite": "SQLITE-FAKE" };
  for (const [nome, conteudo] of Object.entries(vizinhos)) await fs.writeFile(path.join(dir, nome), conteudo);
  return { dir, vizinhos, statePath: path.join(dir, "health-gate-state.json") };
}

await check("aceitarNovaBase escreve só o health-gate-state.json e deixa os outros ficheiros iguais", async () => {
  const { dir, vizinhos, statePath } = await pastaComVizinhos();
  const antes = (await fs.readdir(dir)).sort();
  await fs.writeFile(statePath, JSON.stringify({ catalogTotal: 26180, catalogTotalHistorico: [26180, 26000], resolvedFormatRatioHistorico: [50], cleanTitleDiffHistorico: [9], semEstadoDesde: { V13: "2026-11-01T00:00:00Z" } }));
  const r = await gravarReferencia(statePath, {
    estadoAnterior: await carregarEstado(statePath),
    houveVermelho: true,
    catalogTotal: 23752,
    resolvedFormatRatio: 55.123,
    cleanTitleDiff: 800,
    shop: "loja.myshopify.com",
    horizonteN: 10,
    aceitarNovaBase: true,
  });
  assert.deepEqual(r, { escreveu: true, baseReiniciada: true });
  const depois = (await fs.readdir(dir)).sort();
  assert.deepEqual(depois, [...antes, "health-gate-state.json"].sort());
  for (const [nome, conteudo] of Object.entries(vizinhos)) assert.equal(await fs.readFile(path.join(dir, nome), "utf8"), conteudo, nome);
  const estado = await carregarEstado(statePath);
  assert.equal(estado.catalogTotal, 23752);
  assert.deepEqual(estado.catalogTotalHistorico, [23752], "o histórico recomeça na base nova");
  assert.ok(estado.baseAceiteEm);
  assert.deepEqual(estado.semEstadoDesde, { V13: "2026-11-01T00:00:00Z" }, "o resto do estado fica");
});
await check("sem aceitarNovaBase uma corrida vermelha não escreve nada", async () => {
  const { dir, statePath } = await pastaComVizinhos();
  const antes = (await fs.readdir(dir)).sort();
  const r = await gravarReferencia(statePath, { estadoAnterior: null, houveVermelho: true, catalogTotal: 1, resolvedFormatRatio: 1, shop: "x", horizonteN: 10 });
  assert.equal(r.escreveu, false);
  assert.deepEqual((await fs.readdir(dir)).sort(), antes);
});
await check("gravarSemEstado também só escreve o health-gate-state.json", async () => {
  const { dir, vizinhos, statePath } = await pastaComVizinhos();
  await gravarSemEstado(statePath, { V14: "2026-11-07T00:00:00Z" });
  assert.deepEqual((await fs.readdir(dir)).sort(), [...Object.keys(vizinhos), "health-gate-state.json"].sort());
});
await check("pre-pilot-verify.js não tem escritas próprias e só chama gravarReferencia e gravarSemEstado", async () => {
  const src = semComentarios(fsSync.readFileSync(path.join(ROOT, "scripts/catalog/pre-pilot-verify.js"), "utf8"));
  const escritas = src.match(/writeFile|appendFile|unlink|rmSync|\.rm\(|rename\(|mkdir|\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\$executeRaw|mutation\s*[({A-Za-z]/g);
  assert.equal(escritas, null, `escrita inesperada: ${escritas}`);
  const importados = [...src.matchAll(/import \{([^}]*)\} from/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean));
  const gravadores = importados.filter((n) => n !== "createShopifyClientFromSession").filter((n) => /^(gravar|escrever|write|save|persist|mark|set|registar|upsert|create|delete|apagar)/i.test(n)).sort();
  assert.deepEqual(gravadores, ["gravarReferencia", "gravarSemEstado", "registarSemEstado"].sort());
  assert.match(fsSync.readFileSync(path.join(ROOT, "lib/health/semEstado.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""), /export function registarSemEstado\(mapaAtual, id, temEstado, agoraIso\) \{[^]*?return/);
  assert.ok(!/fs\./.test(fsSync.readFileSync(path.join(ROOT, "lib/health/semEstado.js"), "utf8")), "registarSemEstado é puro, sem fs");
});
await check("o execute do catalog_health no maintenance.sh só tem um comando remoto, o do --aceitar-base", () => {
  const sh = fsSync.readFileSync(path.join(ROOT, "scripts/ci/maintenance.sh"), "utf8");
  const bloco = sh.slice(sh.indexOf("  catalog_health)\n    HEALTH_ACCEPT=false"), sh.indexOf("  diagnose_theme)\n    DESC="));
  const remotos = bloco.match(/remote "[^"]*"/g);
  assert.deepEqual(remotos, ['remote "npm run catalog:health -- --aceitar-base"', 'remote "npm run catalog:health"']);
  assert.ok(!/--execute|db:push|migrate|tags-cleanup|character-pages-sync/.test(bloco));
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nhealth-accept-base-writes: todos os testes passaram");
