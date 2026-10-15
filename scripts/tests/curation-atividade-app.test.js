#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 35, D3 e D7: marcadores de atividade da app e recusas.
 *
 *   D3  o reset Shopify recusa (409) com indexação em curso ou com marcador ilegível.
 *   D7  os scripts que escrevem a fila recusam (código 1, nada gravado) com atividade viva,
 *       e gravam quando não há atividade. Um marcador cujo processo morreu não bloqueia.
 *
 * Usa CURATION_DATA_DIR e DATABASE_URL temporários. Não toca no ficheiro real da fila.
 * Uso: node scripts/tests/curation-atividade-app.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atividadeAppEmCurso,
  marcarAtividadeApp,
  motivoDeRecusaDoReset,
} from "../../lib/curation/atividadeApp.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atividade-app-"));

let falhas = 0;
async function check(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

function limpar() {
  for (const nome of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, nome), { recursive: true, force: true });
}

/** pid de um processo que já terminou: não existe. */
function pidMorto() {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(r.status, 0, "processo de apoio deve terminar limpo");
  return r.pid;
}

await check("sem marcadores não há atividade", () => {
  limpar();
  assert.equal(atividadeAppEmCurso({ dir: tmp }), null);
});

await check("marcador com processo vivo conta como atividade em curso", () => {
  limpar();
  const retirar = marcarAtividadeApp({ tipo: "indexacao", pid: process.pid, dir: tmp });
  const atividade = atividadeAppEmCurso({ dir: tmp });
  assert.equal(atividade?.tipo, "indexacao");
  assert.equal(atividade?.pid, process.pid);
  retirar();
  assert.equal(atividadeAppEmCurso({ dir: tmp }), null, "retirar o marcador tem de o apagar");
});

await check("marcador de processo morto é sobra de crash e não bloqueia", () => {
  limpar();
  const pid = pidMorto();
  marcarAtividadeApp({ tipo: "indexacao", pid, dir: tmp });
  assert.equal(atividadeAppEmCurso({ dir: tmp }), null);
});

await check("marcador escrito antes do arranque desta máquina é sobra e não bloqueia (pid reutilizado)", () => {
  limpar();
  // pid vivo (este processo), mas marcador de há um ano: de outra máquina ou de outro arranque.
  fs.writeFileSync(
    path.join(tmp, "catalog-busy-publicacao-1.json"),
    JSON.stringify({ tipo: "publicacao", pid: process.pid, startedAt: "2025-01-01T00:00:00.000Z" }),
    "utf8"
  );
  assert.equal(atividadeAppEmCurso({ dir: tmp }), null);
});

await check("marcador ilegível conta como atividade desconhecida (fail closed)", () => {
  limpar();
  fs.writeFileSync(path.join(tmp, "catalog-busy-indexacao-1.json"), "{ isto não é json", "utf8");
  const atividade = atividadeAppEmCurso({ dir: tmp });
  assert.equal(atividade?.tipo, "desconhecida");
});

await check("não se consegue marcar atividade sobre um caminho que não é diretório (erro, não silêncio)", () => {
  limpar();
  const ficheiro = path.join(tmp, "nao-e-pasta");
  fs.writeFileSync(ficheiro, "x", "utf8");
  assert.throws(() => marcarAtividadeApp({ tipo: "publicacao", pid: process.pid, dir: ficheiro }));
});

await check("D3: reset recusa com indexação em curso (409)", () => {
  const msg = motivoDeRecusaDoReset({ indexacaoEmCurso: true, atividade: null });
  assert.match(msg, /indexação/);
  const doMarcador = motivoDeRecusaDoReset({ indexacaoEmCurso: false, atividade: { tipo: "indexacao", motivo: "x" } });
  assert.match(doMarcador, /indexação/, "marcador de indexação de outro processo também recusa");
});

await check("D3: reset recusa com marcador ilegível e deixa passar sem atividade", () => {
  assert.match(motivoDeRecusaDoReset({ indexacaoEmCurso: false, atividade: { tipo: "desconhecida", motivo: "ilegível" } }), /ilegível/);
  assert.equal(motivoDeRecusaDoReset({ indexacaoEmCurso: false, atividade: null }), null);
});

/** Corre um script de escrita com a fila temporária. Devolve o código, a saída e a fila em disco. */
function correrScript(argumentos, dir) {
  const r = spawnSync(process.execPath, argumentos, {
    cwd: RAIZ,
    encoding: "utf8",
    env: {
      ...process.env,
      CURATION_DATA_DIR: dir,
      DATABASE_URL: `file:${path.join(dir, "dev.sqlite")}`,
    },
    timeout: 120000,
  });
  return { codigo: r.status, saida: `${r.stdout}\n${r.stderr}` };
}

function filaComOverride(dir) {
  const fila = {
    version: 1,
    updatedAt: null,
    items: [
      {
        sku: "SKU-D7",
        title_en: "Produto de teste",
        status: "PENDING",
        reason: "teste",
        shopifyStatus: "DRAFT",
        metadata: { overrides: { title: "Antigo" }, approvedAt: null, rejectedAt: null },
      },
    ],
  };
  fs.writeFileSync(path.join(dir, "curation-queue.json"), JSON.stringify(fila), "utf8");
  return path.join(dir, "curation-queue.json");
}

await check("D7: script de escrita recusa com atividade da app e não grava", () => {
  limpar();
  const ficheiro = filaComOverride(tmp);
  const antes = fs.readFileSync(ficheiro, "utf8");
  const retirar = marcarAtividadeApp({ tipo: "indexacao", pid: process.pid, dir: tmp });
  try {
    const r = correrScript(["scripts/catalog/curation-override-clear.js", "--sku", "SKU-D7", "--field", "title", "--execute"], tmp);
    assert.equal(r.codigo, 1, `código ${r.codigo}; saída: ${r.saida.slice(-400)}`);
    assert.match(r.saida, /Recusado/);
    assert.equal(fs.readFileSync(ficheiro, "utf8"), antes, "a fila foi alterada apesar da recusa");
  } finally {
    retirar();
  }
});

await check("D7: sem marcador o mesmo script grava (o override sai)", () => {
  limpar();
  const ficheiro = filaComOverride(tmp);
  const r = correrScript(["scripts/catalog/curation-override-clear.js", "--sku", "SKU-D7", "--field", "title", "--execute"], tmp);
  assert.equal(r.codigo, 0, `código ${r.codigo}; saída: ${r.saida.slice(-400)}`);
  const depois = JSON.parse(fs.readFileSync(ficheiro, "utf8")).items[0].metadata.overrides;
  assert.deepEqual(depois, {}, "o override de título tinha de sair");
});

fs.rmSync(tmp, { recursive: true, force: true });
if (falhas) {
  console.error(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log("\ncuration-atividade-app: todos os casos passaram");
