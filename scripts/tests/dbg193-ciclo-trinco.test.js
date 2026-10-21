#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-193 (gate do reset). O ciclo segura o trinco de publicação desde a publicação até ao último passo que escreve
 * na Shopify. Antes de cada passo confirma que ainda o tem. Sai sempre pelo finally do ciclo.
 *   (E1) motor: com manterReserva, a reserva fica com quem chama, mesmo em erro. Sem a opção, sai como antes.
 *   (C1) ciclo: a reserva sobe para o IIFE, e é só daí que sai, no finally.
 *   (C2) ciclo: a publicação corre com manterReserva, e o ciclo não liberta a reserva a meio.
 *   (C3) ciclo: sem publicação (definições ilegíveis), os passos de escrita tomam o trinco antes de correr.
 *   (C4) ciclo: antes de cada passo de escrita (stock, erosão, franquias, novidades, drift, coleções, personagens)
 *        confirma o trinco, e a confirmação vem antes do cliente desse passo.
 * Mutações: M45 o motor libera sempre, M46 a publicação do ciclo sai sem manterReserva, M47 o finally deixa de libertar,
 * M48 a erosão deixa de confirmar o trinco, M49 o ciclo sem publicação deixa de tomar o trinco.
 * Uso: node scripts/tests/dbg193-ciclo-trinco.test.js
 */
import "./_isolate-curation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { semComentarios } from "./_sem-comentarios.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ler = (rel) => semComentarios(fs.readFileSync(path.join(REPO, rel), "utf8"));
const MOTOR = "lib/importer/shopify/shopifyApprovedSync.server.js";
const CICLO = "app/routes/api.trigger-sync.jsx";

const PASSOS = [
  ["o stock dos publicados", "stockClient"],
  ["a erosão de margem", "erosionClient"],
  ["o catálogo de franquias", "franchiseClient"],
  ["as novidades", "naClient"],
  ["o drift", "driftClient"],
  ["as coleções", "collPubClient"],
  ["as personagens", "characterClient"],
];

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

/** Cópia mutada de um módulo, no mesmo diretório (imports relativos). A âncora tem de existir uma vez. */
function copiaMutada(ficheiro, nome, antigo, novo) {
  const origem = path.join(REPO, ficheiro);
  const texto = trocaUma(fs.readFileSync(origem, "utf8"), nome, antigo, novo);
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}${path.extname(origem)}`);
  fs.writeFileSync(destino, texto);
  return destino;
}

// ---------- verificações estáticas sobre o ciclo, sem comentários ----------

function checarCiclo(texto) {
  assert.match(texto, /void \(async \(\) => \{\s*let reservaDoCiclo = null;/, "a reserva do ciclo sobe para o IIFE");
  assert.match(texto, /reservaDoCiclo = reserva;/, "a reserva da publicação fica na reserva do ciclo");
  assert.match(
    texto,
    /runApprovedShopifySync\(session, \{ skipInit: true, reserva, manterReserva: true \}\)/,
    "a publicação do ciclo deixa a reserva com o ciclo"
  );
  assert.doesNotMatch(texto, /\breserva\.libertar\(\)/, "o ciclo não liberta a reserva a meio");
  assert.match(
    texto,
    /finally \{\s*try \{\s*await reservaDoCiclo\?\.libertar\(\);/,
    "o trinco sai no finally do IIFE, em todos os caminhos"
  );
  assert.match(
    texto,
    /if \(!reservaDoCiclo\) \{\s*reservaDoCiclo = await reservarPublicacaoEntreProcessos\(/,
    "sem publicação neste ciclo, os passos de escrita tomam o trinco"
  );
  for (const [nome, cliente] of PASSOS) {
    const guarda = texto.indexOf(`trincoDoCicloAindaTem("${nome}")`);
    const passo = texto.indexOf(`const ${cliente} = createShopifyClientFromSession`);
    assert.ok(guarda > 0, `antes de ${nome} o ciclo confirma o trinco`);
    assert.ok(passo > guarda, `a confirmação de ${nome} vem antes do passo`);
  }
}

console.log("DBG-193 — ciclo segura o trinco até ao último passo que escreve na Shopify");

await caso("(E1) motor: com manterReserva, a reserva fica com quem chama, mesmo em erro", async () => {
  const { runApprovedShopifySync } = await import(pathToFileURL(path.join(REPO, MOTOR)).href);
  let libertou = 0;
  const reserva = { libertar: async () => { libertou += 1; }, aindaTem: async () => true };
  // Sem sessão, o núcleo falha logo à entrada, o que exercita o finally sem tocar na Shopify.
  await runApprovedShopifySync(undefined, { reserva, manterReserva: true }).catch(() => {});
  assert.equal(libertou, 0, "com manterReserva, o motor não liberta a reserva");
  await runApprovedShopifySync(undefined, { reserva }).catch(() => {});
  assert.equal(libertou, 1, "sem manterReserva, o motor liberta a reserva como antes");
});

await caso("(C1-C4) ciclo: reserva no IIFE, publicação com manterReserva, guarda antes de cada passo, finally", () => {
  checarCiclo(ler(CICLO));
});

// ---------- mutações: cada uma tem de ser apanhada ----------

await caso("mutação M45 (DBG-193): o motor libera a reserva mesmo com manterReserva", async () => {
  const copia = copiaMutada(MOTOR, "M45", "if (!opts.manterReserva) await reserva.libertar();", "await reserva.libertar();");
  try {
    const { runApprovedShopifySync } = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M45", async () => {
      let libertou = 0;
      const reserva = { libertar: async () => { libertou += 1; }, aindaTem: async () => true };
      await runApprovedShopifySync(undefined, { reserva, manterReserva: true }).catch(() => {});
      assert.equal(libertou, 0, "com manterReserva, o motor não liberta a reserva");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M46 (DBG-193): a publicação do ciclo sai sem manterReserva", async () => {
  const texto = ler(CICLO);
  const mutado = trocaUma(texto, "M46", "{ skipInit: true, reserva, manterReserva: true }", "{ skipInit: true, reserva }");
  await mutacaoTemDeFalhar("M46", async () => checarCiclo(mutado));
});

await caso("mutação M47 (DBG-193): o finally do ciclo deixa de libertar o trinco", async () => {
  const texto = ler(CICLO);
  const mutado = trocaUma(texto, "M47", "await reservaDoCiclo?.libertar();", "void reservaDoCiclo;");
  await mutacaoTemDeFalhar("M47", async () => checarCiclo(mutado));
});

await caso("mutação M48 (DBG-193): a erosão deixa de confirmar o trinco antes de correr", async () => {
  const texto = ler(CICLO);
  const mutado = trocaUma(texto, "M48", 'if (!(await trincoDoCicloAindaTem("a erosão de margem"))) return;', "");
  await mutacaoTemDeFalhar("M48", async () => checarCiclo(mutado));
});

await caso("mutação M49 (DBG-193): sem publicação, o ciclo deixa de tomar o trinco para os passos de escrita", async () => {
  const texto = ler(CICLO);
  const mutado = trocaUma(
    texto,
    "M49",
    'reservaDoCiclo = await reservarPublicacaoEntreProcessos({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) });',
    "reservaDoCiclo = null;"
  );
  await mutacaoTemDeFalhar("M49", async () => checarCiclo(mutado));
});

if (falhas) {
  console.error(`${falhas} falha(s)`);
  process.exit(1);
}
console.log("DBG-193 — todos os casos passaram");
