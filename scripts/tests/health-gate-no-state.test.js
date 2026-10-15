#!/usr/bin/env node
/**
 * Portão de saúde · ciclos sem estado (DBG-06, relatório de 14/10/2026).
 *
 * Antes, V13, V14, V15 e V17 passavam como `info` (nível pass) quando o ciclo nunca tinha
 * corrido, e o portão ficava verde sem nenhum ciclo ter corrido. Agora sem estado é aviso
 * e, passadas 24 h desde a primeira ausência, vermelho. Estes casos cobrem a lógica
 * (lib/health/semEstado.js) e a gravação de `semEstadoDesde` (gateState.server.js), sem
 * BD, loja ou rede. O próprio script pre-pilot-verify não tem teste: precisa da loja.
 *
 * Uso: node scripts/tests/health-gate-no-state.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gravarReferencia, gravarSemEstado, carregarEstado } from "../../lib/health/gateState.server.js";
import {
  SEM_ESTADO_FAIL_HORAS,
  avaliarSemEstado,
  registarSemEstado,
} from "../../lib/health/semEstado.js";

const HORA_MS = 36e5;
const T0 = "2026-10-15T08:00:00.000Z";
const t0Ms = Date.parse(T0);

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

async function tmpStatePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "health-gate-nostate-"));
  return path.join(dir, "health-gate-state.json");
}

async function main() {
  console.log("registarSemEstado");

  await check("sem estado e sem mapa: regista o instante de agora", () => {
    const m = registarSemEstado(undefined, "V13", false, T0);
    assert.deepEqual(m, { V13: T0 });
  });

  await check("sem estado com data anterior: mantém a primeira ausência", () => {
    const antes = "2026-10-14T08:00:00.000Z";
    const m = registarSemEstado({ V13: antes }, "V13", false, T0);
    assert.equal(m.V13, antes, "a data da primeira ausência não pode avançar a cada corrida");
  });

  await check("com estado: tira o id do mapa (o ciclo voltou a correr)", () => {
    const m = registarSemEstado({ V13: T0, V14: T0 }, "V13", true, "2026-10-16T08:00:00.000Z");
    assert.deepEqual(m, { V14: T0 });
  });

  await check("data guardada que não é ISO: reinicia em agora, não rebenta", () => {
    const m = registarSemEstado({ V15: "lixo" }, "V15", false, T0);
    assert.equal(m.V15, T0);
  });

  await check("não muta o mapa recebido", () => {
    const original = { V13: T0 };
    registarSemEstado(original, "V14", false, T0);
    assert.deepEqual(original, { V13: T0 });
  });

  console.log("avaliarSemEstado");

  await check("limiar de 24 h: 23 h é aviso, 24 h é vermelho", () => {
    assert.equal(SEM_ESTADO_FAIL_HORAS, 24);
    assert.equal(avaliarSemEstado(T0, t0Ms + 23 * HORA_MS).vermelho, false);
    assert.equal(avaliarSemEstado(T0, t0Ms + 24 * HORA_MS).vermelho, true);
    assert.equal(avaliarSemEstado(T0, t0Ms + 25 * HORA_MS).vermelho, true);
  });

  await check("horas reportadas são as decorridas desde a primeira ausência", () => {
    const { horas } = avaliarSemEstado(T0, t0Ms + 3 * HORA_MS);
    assert.equal(horas, 3);
  });

  console.log("gravarSemEstado");

  await check("ficheiro inexistente e mapa vazio: não cria ficheiro", async () => {
    const statePath = await tmpStatePath();
    const escreveu = await gravarSemEstado(statePath, {});
    assert.equal(escreveu, false);
    assert.equal(await carregarEstado(statePath), null);
  });

  await check("ficheiro inexistente e mapa com ciclo: cria só semEstadoDesde", async () => {
    const statePath = await tmpStatePath();
    const escreveu = await gravarSemEstado(statePath, { V17: T0 });
    assert.equal(escreveu, true);
    assert.deepEqual(await carregarEstado(statePath), { semEstadoDesde: { V17: T0 } });
  });

  await check("mapa igual ao gravado: não reescreve", async () => {
    const statePath = await tmpStatePath();
    await gravarSemEstado(statePath, { V17: T0 });
    assert.equal(await gravarSemEstado(statePath, { V17: T0 }), false);
  });

  await check("não apaga a referência: campos de catálogo sobrevivem à gravação", async () => {
    const statePath = await tmpStatePath();
    await gravarReferencia(statePath, {
      estadoAnterior: null,
      houveVermelho: false,
      catalogTotal: 25421,
      resolvedFormatRatio: 55.79,
      shop: "loja-de-teste",
      horizonteN: 10,
    });
    await gravarSemEstado(statePath, { V13: T0 });
    const estado = await carregarEstado(statePath);
    assert.equal(estado.catalogTotal, 25421);
    assert.deepEqual(estado.catalogTotalHistorico, [25421]);
    assert.deepEqual(estado.semEstadoDesde, { V13: T0 });
  });

  await check("corrida vermelha não grava referência, mas grava a ausência", async () => {
    const statePath = await tmpStatePath();
    const { escreveu } = await gravarReferencia(statePath, {
      estadoAnterior: null,
      houveVermelho: true,
      catalogTotal: 1,
      resolvedFormatRatio: 1,
      shop: "loja-de-teste",
      horizonteN: 10,
    });
    assert.equal(escreveu, false, "vermelha não grava referência (ADENDA 4)");
    await gravarSemEstado(statePath, { V14: T0 });
    assert.deepEqual(await carregarEstado(statePath), { semEstadoDesde: { V14: T0 } });
  });

  console.log("sequência entre corridas");

  await check("dia 1 sem estado é aviso; 25 h depois, ainda sem estado, é vermelho; com estado, limpa", async () => {
    let mapa = {};
    // Corrida 1: V13 nunca correu.
    mapa = registarSemEstado(mapa, "V13", false, T0);
    assert.equal(avaliarSemEstado(mapa.V13, t0Ms).vermelho, false, "primeira corrida é aviso");

    // Corrida 2, 25 h depois: continua sem estado.
    const t2 = t0Ms + 25 * HORA_MS;
    mapa = registarSemEstado(mapa, "V13", false, new Date(t2).toISOString());
    assert.equal(mapa.V13, T0, "a data da primeira ausência tem de se manter");
    assert.equal(avaliarSemEstado(mapa.V13, t2).vermelho, true, "25 h sem estado é vermelho");

    // Corrida 3: o trigger-sync correu e gravou o estado.
    mapa = registarSemEstado(mapa, "V13", true, new Date(t2 + HORA_MS).toISOString());
    assert.equal(mapa.V13, undefined);
  });

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nhealth-gate-no-state: todos os casos passaram");
}

main();
