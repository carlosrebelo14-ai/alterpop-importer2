#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-47 (Decisão 28). Nenhuma sessão de leitura ou escrita em massa corre em paralelo com a publicação.
 *   (C1) ciclo: sem reserva (publicação manual ou reset em curso), o ciclo para logo. Não corre o stock, a erosão, as
 *        franquias, as novidades, o drift, as coleções nem as personagens.
 *   (R1) preços: a escrita em massa (execute) toma a reserva da publicação, recusa com 409 se ocupada, e liberta-a no fim.
 *   (R2) radar de vendas: escreve em massa no SQLite, toma a mesma reserva, recusa com 409 se ocupada, e liberta-a no fim.
 * Mutações: M40 o ciclo deixa de parar sem reserva, M41 o radar deixa de tomar a reserva, M42 os preços deixam de
 * recusar com 409.
 * Uso: node scripts/tests/dbg47-rotas-leituras.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { semComentarios } from "./_sem-comentarios.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ler = (rel) => semComentarios(fs.readFileSync(path.join(REPO, rel), "utf8"));

const CICLO = "app/routes/api.trigger-sync.jsx";
const PRECOS = "app/routes/api.curation.reprice-published.jsx";
const RADAR = "app/routes/api.shopify.sales-refresh.jsx";

const RESERVA_PUBLICACAO = 'reservarPublicacaoEntreProcessos({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) })';

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

/** Troca uma âncora que tem de existir exatamente uma vez no texto. Erro do teste, fora de mutacaoTemDeFalhar. */
function trocaUma(texto, nome, antigo, novo) {
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  return texto.replace(antigo, () => novo);
}

// ---------- verificações estáticas, sobre o texto sem comentários ----------

function checarCiclo(texto) {
  // O ramo de reserva ocupada tem de acabar em return, antes do ramo da publicação.
  assert.match(
    texto,
    /else if \(!reserva\) \{[\s\S]*?saltada: \$\{causa\}`\);\s*return;\s*\} else \{/,
    "sem reserva, o ciclo para logo depois de registar o salto"
  );
}

function checarPrecos(texto) {
  assert.ok(texto.includes(RESERVA_PUBLICACAO), "os preços tomam a reserva da publicação");
  assert.match(texto, /if \(!reserva\) \{\s*return Response\.json\(\s*\{ ok: false, code: "PUBLICACAO_EM_CURSO"[^}]*\}\s*,\s*\{ status: 409 \}/, "os preços recusam com 409 se a reserva estiver ocupada");
  assert.match(texto, /finally \{\s*await reserva\.libertar\(\);\s*\}/, "os preços libertam a reserva no fim");
  const reservaAt = texto.indexOf(RESERVA_PUBLICACAO);
  const execAt = texto.indexOf("await executeReprice({");
  assert.ok(reservaAt > 0 && execAt > reservaAt, "a reserva fica antes da escrita em massa");
}

function checarRadar(texto) {
  assert.ok(texto.includes(RESERVA_PUBLICACAO), "o radar toma a reserva da publicação");
  assert.match(texto, /if \(!reserva\) \{\s*return Response\.json\(\s*\{ ok: false, code: "PUBLICACAO_EM_CURSO"[^}]*\}\s*,\s*\{ status: 409 \}/, "o radar recusa com 409 se a reserva estiver ocupada");
  assert.match(texto, /finally \{\s*await reserva\?\.libertar\(\);\s*\}/, "o radar liberta a reserva no fim");
  const reservaAt = texto.indexOf(RESERVA_PUBLICACAO);
  const escritaAt = texto.indexOf("await refreshProductSalesSnapshot(");
  assert.ok(reservaAt > 0 && escritaAt > reservaAt, "a reserva fica antes da escrita em massa");
}

console.log("DBG-47 — rotas e ciclo sem leituras em paralelo com a publicação (Decisão 28)");

await caso("(C1) ciclo: sem reserva, o ciclo para antes de qualquer passo depois da publicação", () => {
  checarCiclo(ler(CICLO));
});

await caso("(R1) preços: escrita em massa sob a reserva da publicação, 409 se ocupada, libertada no fim", () => {
  checarPrecos(ler(PRECOS));
});

await caso("(R2) radar de vendas: escrita em massa sob a reserva da publicação, 409 se ocupada, libertada no fim", () => {
  checarRadar(ler(RADAR));
});

// ---------- mutações: cada uma tem de ser apanhada ----------

await caso("mutação M40 (DBG-47): o ciclo deixa de parar sem reserva", async () => {
  const texto = ler(CICLO);
  // O semComentarios tira a linha de comentário entre o registo e o return, por isso a âncora é por expressão regular.
  const re = /(saltada: \$\{causa\}`\);)\s*return;(\s*\} else \{)/g;
  assert.equal((texto.match(re) || []).length, 1, "M40: o return do ramo sem reserva tem de existir uma vez");
  const mutado = texto.replace(re, "$1$2");
  await mutacaoTemDeFalhar("M40", async () => checarCiclo(mutado));
});

await caso("mutação M41 (DBG-47): o radar deixa de tomar a reserva", async () => {
  const texto = ler(RADAR);
  const mutado = trocaUma(texto, "M41", `reserva = await ${RESERVA_PUBLICACAO};`, "reserva = null;");
  await mutacaoTemDeFalhar("M41", async () => checarRadar(mutado));
});

await caso("mutação M42 (DBG-47): os preços deixam de recusar com 409 quando a reserva está ocupada", async () => {
  const texto = ler(PRECOS);
  const mutado = trocaUma(texto, "M42", "if (!reserva) {\n        return Response.json(", "if (false) {\n        return Response.json(");
  await mutacaoTemDeFalhar("M42", async () => checarPrecos(mutado));
});

if (falhas) {
  console.error(`${falhas} falha(s)`);
  process.exit(1);
}
console.log("DBG-47 — todos os casos passaram");
