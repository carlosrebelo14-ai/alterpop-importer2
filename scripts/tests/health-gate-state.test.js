#!/usr/bin/env node
/**
 * Portão de saúde · estado entre corridas (lib/health/gateState.server.js).
 *
 * Porquê existir: V1, V2 e V4 estiveram verdes por acidente durante dias e ninguém
 * soube, porque ninguém as viu falhar. Os ramos VERMELHOS do estado são da mesma
 * família — só tinham sido lidos, nunca exercitados. Estes são os que transformam um
 * alarme em silêncio se estiverem errados.
 *
 * Estado fabricado num diretório temporário. Sem BD, sem loja, sem rede.
 *
 * Uso: node scripts/tests/health-gate-state.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  avaliarQueda,
  carregarEstado,
  gravarReferencia,
  maxDe,
} from "../../lib/health/gateState.server.js";

const V5_LIMIAR_PCT = 10;
const V7_LIMIAR_PP = 3;
const HORIZONTE_N = 10;

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "health-gate-"));
  return path.join(dir, "health-gate-state.json");
}

/** Uma corrida verde que grava, para semear estado sem duplicar o objeto à mão. */
async function corridaVerde(statePath, { total, ratio }) {
  const estadoAnterior = await carregarEstado(statePath);
  const { escreveu } = await gravarReferencia(statePath, {
    estadoAnterior,
    houveVermelho: false,
    catalogTotal: total,
    resolvedFormatRatio: ratio,
    shop: "loja-de-teste",
    horizonteN: HORIZONTE_N,
  });
  assert.equal(escreveu, true, "corrida verde tinha de gravar");
  return carregarEstado(statePath);
}

async function main() {
  await check(
    "caso 1 — queda de um passo acima do limiar: V5 e V7 ficam vermelhos",
    async () => {
      const statePath = await tmpStatePath();
      const estado = await corridaVerde(statePath, { total: 25421, ratio: 55.79 });

      // O fornecedor larga linhas: 25 421 -> 22 000 (-13,5%) e o rácio cai 5,8 pp.
      const v5 = avaliarQueda({
        anterior: estado.catalogTotal,
        horizonte: maxDe(estado.catalogTotalHistorico),
        atual: 22000,
        limiar: V5_LIMIAR_PCT,
      });
      assert.equal(v5.passa, false, "queda de 13,5% tinha de falhar o V5");
      assert.ok(v5.pior > 13 && v5.pior < 14, `queda calculada fora do esperado: ${v5.pior}`);

      const v7 = avaliarQueda({
        anterior: estado.resolvedFormatRatio,
        horizonte: maxDe(estado.resolvedFormatRatioHistorico),
        atual: 49.99,
        limiar: V7_LIMIAR_PP,
        modo: "pp",
      });
      assert.equal(v7.passa, false, "queda de 5,8 pp tinha de falhar o V7");
    }
  );

  await check(
    "caso 2 — quatro passos de 8%: a comparação anterior deixa passar, o horizonte apanha",
    async () => {
      const statePath = await tmpStatePath();
      await corridaVerde(statePath, { total: 25421, ratio: 55.79 });

      let total = 25421;
      const passosQuePassaramSoContraAnterior = [];
      let apanhadoNoPasso = null;

      for (let passo = 1; passo <= 4; passo++) {
        total = Math.round(total * 0.92); // -8% por corrida
        const estado = await carregarEstado(statePath);

        const soAnterior = avaliarQueda({
          anterior: estado.catalogTotal,
          horizonte: null,
          atual: total,
          limiar: V5_LIMIAR_PCT,
        });
        const comHorizonte = avaliarQueda({
          anterior: estado.catalogTotal,
          horizonte: maxDe(estado.catalogTotalHistorico),
          atual: total,
          limiar: V5_LIMIAR_PCT,
        });

        // Cada passo isolado está sempre dentro do limiar — é esta a falha que o
        // horizonte existe para cobrir.
        assert.equal(soAnterior.passa, true, `passo ${passo}: 8% devia passar contra a corrida anterior`);
        passosQuePassaramSoContraAnterior.push(passo);

        if (!comHorizonte.passa) {
          apanhadoNoPasso = passo;
          break; // vermelha: não grava, o horizonte fica preso no último estado são
        }
        await corridaVerde(statePath, { total, ratio: 55.79 });
      }

      assert.equal(
        passosQuePassaramSoContraAnterior.length >= 2,
        true,
        "pelo menos dois passos tinham de passar a comparação contra a corrida anterior"
      );
      assert.notEqual(apanhadoNoPasso, null, "o horizonte tinha de apanhar a deriva");
      assert.equal(apanhadoNoPasso, 2, `esperava o horizonte a apanhar no passo 2, apanhou no ${apanhadoNoPasso}`);
    }
  );

  await check("caso 3 — corrida vermelha: o ficheiro fica byte a byte igual", async () => {
    const statePath = await tmpStatePath();
    await corridaVerde(statePath, { total: 25421, ratio: 55.79 });

    const antes = await fs.readFile(statePath);
    const estadoAnterior = await carregarEstado(statePath);

    // A corrida vermelha traz números novos e piores. Nenhum deles pode entrar no ficheiro:
    // se entrassem, a corrida seguinte comparava com o valor já partido e passava verde.
    const { escreveu } = await gravarReferencia(statePath, {
      estadoAnterior,
      houveVermelho: true,
      catalogTotal: 12000,
      resolvedFormatRatio: 20.0,
      shop: "loja-de-teste",
      horizonteN: HORIZONTE_N,
    });

    const depois = await fs.readFile(statePath);
    assert.equal(escreveu, false, "corrida vermelha não pode gravar");
    assert.equal(Buffer.compare(antes, depois), 0, "ficheiro mudou depois de uma corrida vermelha");

    // E a referência continua a ser a boa, não a partida.
    const estadoFinal = await carregarEstado(statePath);
    assert.equal(estadoFinal.catalogTotal, 25421);
    assert.deepEqual(estadoFinal.catalogTotalHistorico, [25421]);
  });

  await check(
    "caso 4 — descida legítima prende o portão, e --aceitar-base destrava-o sem apagar o ficheiro",
    async () => {
      const statePath = await tmpStatePath();
      await corridaVerde(statePath, { total: 25421, ratio: 55.79 });

      // O fornecedor larga linhas. A descida é real e não vai voltar atrás.
      const NOVO_TOTAL = 22000;
      const avaliar = async () => {
        const e = await carregarEstado(statePath);
        return avaliarQueda({
          anterior: e.catalogTotal,
          horizonte: maxDe(e.catalogTotalHistorico),
          atual: NOVO_TOTAL,
          limiar: V5_LIMIAR_PCT,
        });
      };

      // Duas corridas seguidas: vermelha, não grava, e a segunda fica vermelha pelo
      // mesmo motivo. É aqui que o portão deixava de poder voltar ao verde por si.
      for (const corrida of [1, 2]) {
        const v5 = await avaliar();
        assert.equal(v5.passa, false, `corrida ${corrida}: devia estar vermelha`);
        const { escreveu } = await gravarReferencia(statePath, {
          estadoAnterior: await carregarEstado(statePath),
          houveVermelho: true,
          catalogTotal: NOVO_TOTAL,
          resolvedFormatRatio: 55.79,
          shop: "loja-de-teste",
          horizonteN: HORIZONTE_N,
        });
        assert.equal(escreveu, false, `corrida ${corrida}: vermelha não grava`);
      }

      // O humano julga que a descida é real e carrega no botão.
      const antes = await fs.readFile(statePath);
      const r = await gravarReferencia(statePath, {
        estadoAnterior: await carregarEstado(statePath),
        houveVermelho: true,
        catalogTotal: NOVO_TOTAL,
        resolvedFormatRatio: 55.79,
        shop: "loja-de-teste",
        horizonteN: HORIZONTE_N,
        aceitarNovaBase: true,
      });
      assert.equal(r.escreveu, true, "--aceitar-base tem de gravar mesmo com a corrida vermelha");
      assert.equal(r.baseReiniciada, true);
      assert.notEqual(Buffer.compare(antes, await fs.readFile(statePath)), 0, "o ficheiro tinha de mudar");

      // O ponto fino: sem reiniciar o histórico, o máximo antigo continuava no horizonte
      // e a corrida seguinte ficava vermelha na mesma — o botão não destravava nada.
      const estado = await carregarEstado(statePath);
      assert.deepEqual(estado.catalogTotalHistorico, [NOVO_TOTAL], "histórico tinha de ser reiniciado");
      assert.equal(maxDe(estado.catalogTotalHistorico), NOVO_TOTAL);
      assert.ok(estado.baseAceiteEm, "a aceitação tem de ficar carimbada no ficheiro");

      // E a corrida seguinte, com o catálogo estável no valor novo, volta ao verde.
      const depois = await avaliar();
      assert.equal(depois.passa, true, "depois de aceitar a base, o portão tem de poder voltar ao verde");
    }
  );

  await check(
    "caso 5 — cleanTitleDiff (V6, 16/09/2026): grava, compara por queda, e é opcional sem partir chamadores antigos",
    async () => {
      const statePath = await tmpStatePath();

      // Chamador antigo, sem cleanTitleDiff — não pode rebentar nem inventar o campo.
      const estadoAnterior1 = await carregarEstado(statePath);
      const r1 = await gravarReferencia(statePath, {
        estadoAnterior: estadoAnterior1,
        houveVermelho: false,
        catalogTotal: 25421,
        resolvedFormatRatio: 55.79,
        shop: "loja-de-teste",
        horizonteN: HORIZONTE_N,
      });
      assert.equal(r1.escreveu, true);
      const estado1 = await carregarEstado(statePath);
      assert.equal(estado1.cleanTitleDiff, undefined, "sem cleanTitleDiff no args, o campo não deve aparecer");

      // Agora com cleanTitleDiff — grava valor e arranca o histórico.
      const r2 = await gravarReferencia(statePath, {
        estadoAnterior: estado1,
        houveVermelho: false,
        catalogTotal: 25421,
        resolvedFormatRatio: 55.79,
        cleanTitleDiff: 5884,
        shop: "loja-de-teste",
        horizonteN: HORIZONTE_N,
      });
      assert.equal(r2.escreveu, true);
      const estado2 = await carregarEstado(statePath);
      assert.equal(estado2.cleanTitleDiff, 5884);
      assert.deepEqual(estado2.cleanTitleDiffHistorico, [5884]);

      // Queda de 20% (> 15%, o limiar de V6) tem de travar.
      const v6Queda = avaliarQueda({
        anterior: estado2.cleanTitleDiff,
        horizonte: maxDe(estado2.cleanTitleDiffHistorico),
        atual: 4707, // -20% de 5884
        limiar: 15,
      });
      assert.equal(v6Queda.passa, false, "queda de 20% tinha de falhar o limiar de 15%");

      // Crescimento nunca é vermelho, mesmo que grande.
      const v6Crescimento = avaliarQueda({
        anterior: estado2.cleanTitleDiff,
        horizonte: maxDe(estado2.cleanTitleDiffHistorico),
        atual: 9000,
        limiar: 15,
      });
      assert.equal(v6Crescimento.passa, true, "crescimento não pode ser vermelho");
    }
  );

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nhealth-gate-state: todos os casos passaram");
}

main();
