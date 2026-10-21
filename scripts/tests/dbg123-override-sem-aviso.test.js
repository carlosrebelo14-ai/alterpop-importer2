#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-123. Com o override já gravado, a linha de import de edições diz que a aprovação ou a rejeição não ficou feita,
 * qualquer que seja a causa. O DBG-110 cobria só o timeout da fila.
 *   (H1) sem override gravado, o motivo é a mensagem do erro, ou a mensagem por omissão.
 *   (H2) timeout da fila com override gravado: a mensagem de fila ocupada, como antes.
 *   (H3) outra causa com override gravado (por exemplo APPROVE_PUBLISHED): o motivo diz que o override ficou gravado e
 *        que a aprovação ou a rejeição não, e traz a causa.
 *   (H4) erro sem mensagem com override gravado: o motivo continua a dizer o que ficou gravado.
 *   (R1) a rota passa o motivo pelo helper, com o estado do override.
 * Mutações: M43 o helper ignora o estado do override, M44 o helper deixa de dizer que o override ficou gravado.
 * Uso: node scripts/tests/dbg123-override-sem-aviso.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { semComentarios } from "./_sem-comentarios.js";
import { motivoDaLinhaRecusada } from "../../lib/curation/motivoLinhaEdicao.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROTA = "app/routes/api.products.import-edits.jsx";
const HELPER = "lib/curation/motivoLinhaEdicao.js";

const FILA_OCUPADA = "fila ocupada: o override foi gravado, a aprovação ou a rejeição não. Repetir esta linha.";

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

/** Mutação que tem de ser apanhada: se a suíte passar com ela, falha. */
async function mutacaoTemDeFalhar(nome, fn) {
  let apanhou = false;
  try {
    await fn();
  } catch {
    apanhou = true;
  }
  if (!apanhou) throw new Error(`mutação ${nome}: a suíte não a apanhou`);
}

/** Cópia mutada do helper, no mesmo diretório (imports relativos). A âncora tem de existir uma vez. */
function copiaMutada(ficheiro, nome, antigo, novo) {
  const origem = path.join(REPO, ficheiro);
  const texto = fs.readFileSync(origem, "utf8");
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}${path.extname(origem)}`);
  fs.writeFileSync(destino, texto.replace(antigo, () => novo));
  return destino;
}

console.log("DBG-123 — override gravado sem aviso no import de edições");

await caso("(H1) sem override gravado, o motivo é a mensagem do erro, ou a mensagem por omissão", () => {
  assert.equal(motivoDaLinhaRecusada({ err: new Error("Produto apagado"), gravou: false }), "Produto apagado");
  assert.equal(motivoDaLinhaRecusada({ err: {}, gravou: false }), "Erro desconhecido ao aplicar");
});

await caso("(H2) timeout da fila com override gravado: a mensagem de fila ocupada, como antes", () => {
  const err = Object.assign(new Error("timeout"), { code: "CURATION_QUEUE_LOCK_TIMEOUT" });
  assert.equal(motivoDaLinhaRecusada({ err, gravou: true }), FILA_OCUPADA);
});

await caso("(H3) outra causa com override gravado: diz que o override ficou gravado e traz a causa", () => {
  const err = Object.assign(new Error("Produto já publicado"), { code: "APPROVE_PUBLISHED" });
  const motivo = motivoDaLinhaRecusada({ err, gravou: true });
  assert.ok(motivo.includes("o override foi gravado, a aprovação ou a rejeição não"), motivo);
  assert.ok(motivo.includes("Produto já publicado"), motivo);
  assert.ok(!motivo.includes("Repetir"), "a causa não é de fila, e não manda repetir a linha");
});

await caso("(H5) timeout da fila sem override gravado: a mensagem do erro, sem afirmar uma escrita que não houve", () => {
  const err = Object.assign(new Error("[fila] espera esgotada. Nada foi escrito."), { code: "CURATION_QUEUE_LOCK_TIMEOUT" });
  assert.equal(motivoDaLinhaRecusada({ err, gravou: false }), "[fila] espera esgotada. Nada foi escrito.");
});

await caso("(H4) erro sem mensagem com override gravado: continua a dizer o que ficou gravado", () => {
  const motivo = motivoDaLinhaRecusada({ err: {}, gravou: true });
  assert.ok(motivo.includes("o override foi gravado, a aprovação ou a rejeição não"), motivo);
  assert.ok(motivo.includes("Erro desconhecido ao aplicar"), motivo);
});

await caso("(R1) a rota passa o motivo pelo helper, com o estado do override", () => {
  const codigo = semComentarios(fs.readFileSync(path.join(REPO, ROTA), "utf8"));
  assert.match(
    codigo,
    /rejected\.push\(\{ line: lineNo, sku, reason: motivoDaLinhaRecusada\(\{ err, gravou \}\) \}\);/,
    "o motivo devolvido pelo helper chega à linha recusada"
  );
  assert.doesNotMatch(codigo, /filaOcupada && gravou/, "a condição antiga, só para o timeout, saiu da rota");
});

await caso("mutação M43 (DBG-123): o helper ignora o estado do override", async () => {
  const copia = copiaMutada(HELPER, "M43", "if (!gravou) return mensagem;", "if (true) return mensagem;");
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M43", async () => {
      const err = Object.assign(new Error("Produto já publicado"), { code: "APPROVE_PUBLISHED" });
      const motivo = m.motivoDaLinhaRecusada({ err, gravou: true });
      assert.ok(motivo.includes("o override foi gravado"), motivo);
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M44 (DBG-123): o helper deixa de dizer que o override ficou gravado", async () => {
  const copia = copiaMutada(
    HELPER,
    "M44",
    "return `o override foi gravado, a aprovação ou a rejeição não (${mensagem}).`;",
    "return `a aprovação ou a rejeição não (${mensagem}).`;"
  );
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M44", async () => {
      const err = Object.assign(new Error("Produto já publicado"), { code: "APPROVE_PUBLISHED" });
      const motivo = m.motivoDaLinhaRecusada({ err, gravou: true });
      assert.ok(motivo.includes("o override foi gravado"), motivo);
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

if (falhas) {
  console.error(`${falhas} falha(s)`);
  process.exit(1);
}
console.log("DBG-123 — todos os casos passaram");
