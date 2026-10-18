#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-105. Teste estático das rotas de publicação: a reserva (lib/importer/shopify/publicacaoEmCurso.js) é tomada
 * na rota manual e no ciclo, sem await entre a reserva e o arranque, e force não a salta.
 *   (R1) rota manual: a reserva fica depois do gate de estado e antes de initShopifySyncJob, e segue para o motor;
 *   (F)  force=1 não salta a reserva: a reserva tem a forma exata, fora do bloco do gate de estado;
 *   (R2) ciclo: a reserva fica logo antes da chamada a runApprovedShopifySync, e a chamada leva a reserva;
 *   (E)  o motor usa a reserva da rota, ou reserva ele próprio quando não há reserva.
 * Uso: node scripts/tests/publicacao-reserva-rotas.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { semComentarios } from "./_sem-comentarios.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ler = (rel) => semComentarios(fs.readFileSync(path.join(REPO, rel), "utf8"));
const RESERVA = "reserva = tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: \"publicacao\" }) });";

let falhas = 0;
function check(nome, fn) {
  try {
    fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

console.log("DBG-105 — reserva de publicação nas rotas e no motor");

check("(R1) rota manual: reserva depois do gate de estado e antes de initShopifySyncJob, sem await pelo meio", () => {
  const manual = ler("app/routes/api.shopify-sync.jsx");
  const reserva = manual.indexOf(RESERVA);
  assert.ok(reserva > 0, "a rota manual tem de reservar com a marca da app: reserva = tentarReservarPublicacao({ marcar: ... })");
  const init = manual.indexOf("await initShopifySyncJob(session.shop");
  assert.ok(init > reserva, "a reserva fica antes do initShopifySyncJob");
  assert.doesNotMatch(manual.slice(reserva, init), /await/, "sem await entre a reserva e o arranque");
  assert.ok(
    manual.includes("startApprovedShopifySyncInBackground(session, { skus: approvedSkus, reserva });"),
    "a reserva segue para o motor em background"
  );
});

check("(F) force=1 não salta a reserva: a reserva está fora do bloco do gate de estado, com a forma exata", () => {
  const manual = ler("app/routes/api.shopify-sync.jsx");
  const gate = /if \(!force && \(await isShopifySyncRunning\(session\.shop\)\)\) \{[\s\S]*?\n {2}\}\n/.exec(manual);
  assert.ok(gate, "o gate de estado continua a ser if (!force && ...), com bloco de retorno");
  const reserva = manual.indexOf(RESERVA);
  assert.ok(reserva >= gate.index + gate[0].length, "a reserva fica fora do gate, por isso force não a salta");
  assert.doesNotMatch(manual, /force\s*\?[^;]*tentarReservarPublicacao/, "nenhuma reserva condicionada por force");
});

check("(R2) ciclo: reserva logo antes da chamada a runApprovedShopifySync, sem await pelo meio", () => {
  const ciclo = ler("app/routes/api.trigger-sync.jsx");
  const reserva = ciclo.indexOf(RESERVA);
  assert.ok(reserva > 0, "o ciclo tem de reservar com a marca da app: reserva = tentarReservarPublicacao({ marcar: ... })");
  const chamada = ciclo.indexOf("await runApprovedShopifySync(session, { skipInit: true, reserva });");
  assert.ok(chamada > reserva, "a reserva fica antes da chamada, e a chamada leva a reserva");
  // PR 5 (revisão): o ramo de salto pode esperar pela marcação da erosão. A regra vale para o caminho de publicação:
  // nenhum await entre a reserva e a decisão, nem entre o else da decisão e a chamada.
  const decisao = ciclo.indexOf("motivoIndexacao = motivoDeRecusaDaPublicacaoManual({");
  assert.ok(decisao > reserva && decisao < chamada, "a decisão de indexação fica entre a reserva e a chamada");
  // Os ramos de marca falhada e de reserva ocupada ficam entre a reserva e a decisão. O caminho de publicação começa na
  // declaração da decisão, e é aí que a regra de não haver await se aplica.
  const declaracao = ciclo.indexOf("let motivoIndexacao = null;");
  assert.ok(declaracao > reserva && declaracao < decisao, "a declaração da decisão fica depois da reserva");
  assert.doesNotMatch(ciclo.slice(declaracao, decisao), /await/, "sem await entre a declaração da decisão e a decisão");
  const entrada = ciclo.indexOf("} else {", decisao);
  assert.ok(entrada > decisao && entrada < chamada, "o caminho de publicação está no else da decisão");
  assert.doesNotMatch(ciclo.slice(entrada, chamada), /await/, "sem await entre o else e a chamada da publicação");
});

check("(E) motor: usa a reserva da rota, ou reserva ele próprio, e liberta-a sempre", () => {
  const motor = ler("lib/importer/shopify/shopifyApprovedSync.server.js");
  assert.ok(
    motor.includes("const reserva = opts.reserva ?? tentarReservarPublicacao();"),
    "o motor usa opts.reserva, ou reserva quando não há"
  );
  assert.ok(motor.includes("reserva.libertar();"), "a reserva é libertada no finally");
});

if (falhas) {
  console.error(`\npublicacao-reserva-rotas: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\npublicacao-reserva-rotas: todos os casos passaram");
