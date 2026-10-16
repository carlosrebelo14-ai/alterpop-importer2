#!/usr/bin/env node
/* eslint-env node */
/**
 * Lote 2b-1, Decisão 6 do arquiteto. Estado de indexação ilegível conta como falhado. O ciclo
 * recusa publicar e regista a recusa.
 *
 * - Ficheiro de estado inexistente é idle. É a primeira execução, não é erro (a).
 * - Ficheiro existente que não se lê, ou cujo JSON não é um objeto, é failed com a mensagem
 *   "estado de indexação ilegível" (b). O arranque e o ciclo leem pela mesma função, por isso o
 *   estado é o mesmo nos dois (c).
 * - podePublicarDepoisDaIndexacao: false para failed e para estado ilegível, true para idle (c).
 *   Ilegível não retoma.
 * - Estático (d): o ciclo automático (api.trigger-sync.jsx) testa a função antes de publicar e o
 *   ramo de recusa tem a marca "[ciclo] publicação recusada: estado de indexação falhado".
 *
 * PROJECT_ROOT aponta para um diretório temporário, para o estado de indexação não ir para data/ do
 * repositório. Os ficheiros de estado são criados à mão dentro desse diretório.
 *
 * Uso: node scripts/tests/catalog-estado-ilegivel.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fecho, semComentarios } from "./_sem-comentarios.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "estado-ilegivel-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// Antes de importar os módulos. A configuração lê PROJECT_ROOT ao carregar.
process.env.PROJECT_ROOT = path.join(tmp, "projeto");

const modulo = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const estado = await modulo("lib/importer/catalog/catalogRebuildStatus.server.js");

const DIR_ESTADO = path.join(tmp, "projeto", "data", "catalog-index");
const ficheiroDe = (loja) => path.join(DIR_ESTADO, `${loja}-rebuild-status.json`);

const SEM_FICHEIRO = "loja-sem-estado.myshopify.com";
const JSON_INVALIDO = "loja-json-invalido.myshopify.com";
const NAO_OBJETO = "loja-json-nulo.myshopify.com";
// Um diretório no lugar do ficheiro dá EISDIR ao ler: existe, mas não se lê.
const ILEGIVEL = "loja-ilegivel.myshopify.com";
const ILEGIVEIS = [JSON_INVALIDO, NAO_OBJETO, ILEGIVEL];
const MENSAGEM = /estado de indexação ilegível/;

fs.mkdirSync(DIR_ESTADO, { recursive: true });
fs.writeFileSync(ficheiroDe(JSON_INVALIDO), '{"state": "completed", ', "utf8");
fs.writeFileSync(ficheiroDe(NAO_OBJETO), "null", "utf8");
fs.mkdirSync(ficheiroDe(ILEGIVEL), { recursive: true });

let falhas = 0;
async function caso(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

await caso("(a) ficheiro inexistente devolve idle, no disco e na leitura do arranque", async () => {
  const emDisco = await estado.readCatalogRebuildStatusFromDisk(SEM_FICHEIRO);
  assert.equal(emDisco?.state, "idle", "no disco, sem ficheiro, o estado é idle");
  assert.equal(emDisco?.error, null);

  const leitura = await estado.readCatalogRebuildStatus(SEM_FICHEIRO);
  assert.equal(leitura?.state, "idle", "na leitura do arranque e do ciclo, sem ficheiro, o estado é idle");
});

await caso("(b) ficheiro com JSON inválido, JSON que não é objeto, ou não legível devolve failed com a mensagem", async () => {
  for (const loja of ILEGIVEIS) {
    const emDisco = await estado.readCatalogRebuildStatusFromDisk(loja);
    assert.equal(emDisco?.state, "failed", `${loja}: no disco o estado tem de ser failed`);
    assert.match(emDisco?.error ?? "", MENSAGEM, `${loja}: no disco a mensagem tem de dizer que o estado é ilegível`);

    const leitura = await estado.readCatalogRebuildStatus(loja);
    assert.equal(leitura?.state, "failed", `${loja}: no arranque e no ciclo o estado tem de ser failed`);
    assert.match(leitura?.error ?? "", MENSAGEM, `${loja}: no arranque e no ciclo a mensagem tem de dizer que o estado é ilegível`);
  }
});

await caso("(c) podePublicarDepoisDaIndexacao: false para failed e para estado ilegível, true para idle", async () => {
  assert.equal(estado.podePublicarDepoisDaIndexacao({ state: "failed", error: "falha do worker" }), false);
  assert.equal(estado.podePublicarDepoisDaIndexacao({ state: "failed", error: null }), false, "failed sem mensagem também recusa");
  assert.equal(estado.podePublicarDepoisDaIndexacao({ state: "completed", error: "algo correu mal" }), false);
  assert.equal(estado.podePublicarDepoisDaIndexacao(null), false);
  assert.equal(estado.podePublicarDepoisDaIndexacao(undefined), false);
  assert.equal(estado.podePublicarDepoisDaIndexacao({ state: "completed", error: null }), true);

  const sem = await estado.readCatalogRebuildStatus(SEM_FICHEIRO);
  assert.equal(estado.podePublicarDepoisDaIndexacao(sem), true, "idle deixa publicar");

  for (const loja of ILEGIVEIS) {
    const leitura = await estado.readCatalogRebuildStatus(loja);
    assert.equal(estado.podePublicarDepoisDaIndexacao(leitura), false, `${loja}: estado ilegível recusa publicar`);
    assert.equal(estado.canResumeCatalogRebuild(leitura), false, `${loja}: estado ilegível não retoma a indexação`);
  }
});

await caso("(d) o ciclo automático testa a função antes de publicar, e o ramo de recusa tem a marca e não publica", async () => {
  const rota = semComentarios(fs.readFileSync(path.join(RAIZ, "app/routes/api.trigger-sync.jsx"), "utf8"));

  assert.match(
    rota,
    /import\s*\{[^}]*\bpodePublicarDepoisDaIndexacao\b[^}]*\}\s*from\s*"\.\.\/\.\.\/lib\/importer\/catalog\/catalogRebuildStatus\.server\.js"/,
    "a rota tem de importar a função do módulo de estado de indexação"
  );

  const chamada = rota.search(/if\s*\(\s*!\s*podePublicarDepoisDaIndexacao\s*\(\s*status\s*\)\s*\)\s*\{/);
  assert.ok(chamada >= 0, "o ciclo tem de testar podePublicarDepoisDaIndexacao(status) antes de publicar");

  const abre = rota.indexOf("{", chamada);
  const ramo = rota.slice(abre, fecho(rota, abre, "{", "}") + 1);
  assert.ok(
    ramo.includes("[ciclo] publicação recusada: estado de indexação falhado"),
    "o ramo de recusa tem de registar a marca estável"
  );
  assert.match(ramo, /\breturn\b/, "o ramo de recusa tem de sair sem publicar");

  const publica = rota.indexOf("await runApprovedShopifySync(");
  assert.ok(publica > chamada, "a recusa tem de vir antes da chamada de publicação");
});

if (falhas) {
  console.error(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log("\ncatalog-estado-ilegivel: todos os casos passaram");
