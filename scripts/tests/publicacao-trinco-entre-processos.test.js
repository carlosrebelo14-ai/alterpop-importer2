#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-142 (decisão do arquiteto, 21/10): a publicação é exclusiva entre processos. A publicação manual, o ciclo, o
 * reset e o run-approved-sync tomam o mesmo trinco de ficheiro. Quem o encontra ocupado recusa, sem esperar: a rota
 * responde 409 (ou o ciclo salta, com registo), e o script sai com código diferente de 0.
 *
 * Mutações: cada correção tem uma troca que tem de deixar um caso vermelho (cópia do ficheiro no mesmo diretório).
 *
 * Uso: node scripts/tests/publicacao-trinco-entre-processos.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const modulo = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const pub = await modulo("lib/importer/shopify/publicacaoEmCurso.js");
const trinco = await modulo("lib/curation/curationQueueFileLock.server.js");

const PUBLICACAO = "lib/importer/shopify/publicacaoEmCurso.js";
const RUN_APPROVED = "scripts/catalog/run-approved-sync.js";
const ROTAS = [
  "app/routes/api.shopify-sync.jsx",
  "app/routes/api.shopify-reset.jsx",
  "app/routes/api.trigger-sync.jsx",
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

/** Uma mutação tem de fazer a verificação falhar. Se passar, a suíte não a apanha. */
async function mutacaoTemDeFalhar(nome, fn) {
  let apanhou = false;
  try {
    await fn();
  } catch {
    apanhou = true;
  }
  if (!apanhou) throw new Error(`mutação ${nome}: a suíte não a apanhou`);
}

/**
 * Cópia mutada de um módulo ou script, no mesmo diretório (imports relativos). A âncora tem de existir uma vez, e isto
 * corre fora de mutacaoTemDeFalhar: uma âncora errada é erro do teste, não mutação apanhada.
 */
function copiaMutada(ficheiro, nome, antigo, novo) {
  const origem = path.join(REPO, ficheiro);
  const texto = fs.readFileSync(origem, "utf8");
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}${path.extname(origem)}`);
  fs.writeFileSync(destino, texto.replace(antigo, () => novo));
  return destino;
}

/** Trinco da publicação tomado por outro processo (aqui, o mesmo módulo de trinco, com este pid). */
async function tomarTrincoDeOutroProcesso() {
  const caminho = pub.caminhoDoTrincoDePublicacao();
  fs.rmSync(caminho, { force: true });
  return trinco.adquirirLockDoFicheiro(caminho, { prazoMs: 1000 });
}

/** Fila com um item APPROVED, para o run-approved-sync chegar ao motor. */
function escreverFilaAprovada() {
  fs.writeFileSync(
    path.join(process.env.CURATION_DATA_DIR, "curation-queue.json"),
    JSON.stringify({
      version: 1,
      updatedAt: null,
      items: [
        {
          sku: "S1",
          title_en: "Produto S1",
          status: "APPROVED",
          reason: "manual_dashboard",
          shopifyStatus: "DRAFT",
          statusChangedAt: "2026-10-01T10:00:00.000Z",
          metadata: { origem: "humano", shopifyProductId: null, approvedAt: "2026-10-01T10:00:00.000Z" },
        },
      ],
    })
  );
}

console.log("publicacao-trinco-entre-processos — DBG-142, trinco de publicação entre processos");

await caso("DBG-142: com o trinco de outro processo, a reserva recusa-se e a reserva em memória sai", async () => {
  const titular = await tomarTrincoDeOutroProcesso();
  try {
    const reserva = await pub.reservarPublicacaoEntreProcessos();
    assert.equal(reserva, null, "um trinco ocupado recusa a publicação");
    assert.equal(pub.publicacaoOuResetEmCurso(), false, "a reserva em memória sai quando o trinco falha");
  } finally {
    await trinco.libertarLockDoFicheiro(titular);
  }
});

await caso("DBG-142: livre, a reserva toma-se, e o trinco sai com ela", async () => {
  const caminho = pub.caminhoDoTrincoDePublicacao();
  fs.rmSync(caminho, { force: true });
  const reserva = await pub.reservarPublicacaoEntreProcessos();
  assert.ok(reserva, "livre, a reserva toma-se");
  assert.equal(pub.publicacaoOuResetEmCurso(), true);
  assert.ok(fs.existsSync(caminho), "o trinco existe enquanto a publicação corre");
  await reserva.libertar();
  assert.equal(pub.publicacaoOuResetEmCurso(), false);
  assert.equal(fs.existsSync(caminho), false, "o trinco sai com a reserva");
});

await caso("DBG-142: run-approved-sync com o trinco de outro processo recusa-se, com saída diferente de 0 e sem publicar", async () => {
  escreverFilaAprovada();
  const titular = await tomarTrincoDeOutroProcesso();
  try {
    const r = spawnSync(process.execPath, [path.join(REPO, RUN_APPROVED), "--shop", "loja-teste.myshopify.com"], {
      encoding: "utf8",
      env: process.env,
      timeout: 60000,
    });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /Recusado: publish_already_running/);
    assert.doesNotMatch(r.stdout, /resultado/, "não chega ao motor");
  } finally {
    await trinco.libertarLockDoFicheiro(titular);
  }
});

await caso("DBG-142: as rotas e o motor tomam a reserva entre processos (estático)", () => {
  for (const ficheiro of [...ROTAS, "lib/importer/shopify/shopifyReset.server.js", "lib/importer/shopify/shopifyApprovedSync.server.js"]) {
    const texto = fs.readFileSync(path.join(REPO, ficheiro), "utf8");
    assert.doesNotMatch(texto, /tentarReservarPublicacao\(/, `${ficheiro} não usa a reserva só em memória`);
    assert.match(texto, /reservarPublicacaoEntreProcessos\(/, ficheiro);
  }
});

await caso("mutação M27 (DBG-142): sem o trinco de ficheiro, a reserva entre processos passa", async () => {
  const copia = copiaMutada(PUBLICACAO, "M27", "    trinco = await adquirirLockDoFicheiro(caminhoDoTrincoDePublicacao(), {", "    trinco = await adquirirLockDoFicheiro(caminhoDoTrincoDePublicacao() + Math.random(), {");
  try {
    const m = await import(pathToFileURL(copia).href);
    const titular = await tomarTrincoDeOutroProcesso();
    try {
      await mutacaoTemDeFalhar("M27", async () => {
        const reserva = await m.reservarPublicacaoEntreProcessos();
        if (reserva) await reserva.libertar();
        assert.equal(reserva, null, "um trinco ocupado recusa a publicação");
      });
    } finally {
      await trinco.libertarLockDoFicheiro(titular);
    }
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M28 (DBG-142): o run-approved-sync recusado continua até ao motor e sai com 0", async () => {
  const copia = copiaMutada(RUN_APPROVED, "M28", "    process.exit(3);\n  }\n  const ms = Date.now() - t0;", "    // M28 mutado\n  }\n  const ms = Date.now() - t0;");
  try {
    escreverFilaAprovada();
    const titular = await tomarTrincoDeOutroProcesso();
    try {
      await mutacaoTemDeFalhar("M28", async () => {
        const r = spawnSync(process.execPath, [copia, "--shop", "loja-teste.myshopify.com"], { encoding: "utf8", env: process.env, timeout: 60000 });
        assert.equal(r.status, 3, r.stdout + r.stderr);
      });
    } finally {
      await trinco.libertarLockDoFicheiro(titular);
    }
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M29 (DBG-142): uma rota volta à reserva só em memória", async () => {
  const texto = fs.readFileSync(path.join(REPO, "app/routes/api.trigger-sync.jsx"), "utf8");
  const antigo = "reserva = await reservarPublicacaoEntreProcessos({";
  assert.equal(texto.split(antigo).length - 1, 1, "M29: a âncora tem de existir uma vez");
  await mutacaoTemDeFalhar("M29", async () => {
    assert.doesNotMatch(texto.replace(antigo, "reserva = tentarReservarPublicacao({"), /tentarReservarPublicacao\(/);
  });
});

/** Trinco obsoleto (titular morto) num caminho próprio do teste. */
function escreverTrincoObsoleto(caminho) {
  fs.writeFileSync(
    caminho,
    JSON.stringify({ pid: 2147483000, em: "2020-01-01T00:00:00.000Z", token: "titular-morto" })
  );
}

await caso("DBG-142 (lente de delta): com a tomada do obsoleto ocupada, o trinco obsoleto não se remove", async () => {
  const caminho = path.join(process.env.CURATION_DATA_DIR, "obsoleto-tomada.lock");
  fs.rmSync(caminho, { force: true });
  fs.rmSync(`${caminho}.tomada`, { recursive: true, force: true });
  escreverTrincoObsoleto(caminho);
  fs.mkdirSync(`${caminho}.tomada`);
  try {
    await assert.rejects(trinco.adquirirLockDoFicheiro(caminho, { prazoMs: 0 }), trinco.CurationQueueLockError);
    assert.ok(fs.existsSync(caminho), "com outro processo a tomar o obsoleto, este não o apaga");
  } finally {
    fs.rmSync(`${caminho}.tomada`, { recursive: true, force: true });
  }
  const titular = await trinco.adquirirLockDoFicheiro(caminho, { prazoMs: 0 });
  assert.ok(titular, "sem tomada, o obsoleto remove-se e o trinco toma-se");
  await trinco.libertarLockDoFicheiro(titular);
});

await caso("mutação M30 (DBG-142): sem a tomada do obsoleto, o trinco obsoleto é removido por cima de outro processo", async () => {
  const copia = copiaMutada("lib/curation/curationQueueFileLock.server.js", "M30", "  const resultado = await comTomadaDoObsoleto(lockPath, async () => {", "  const resultado = await ((_p, tarefa) => tarefa())(lockPath, async () => {");
  const caminho = path.join(process.env.CURATION_DATA_DIR, "obsoleto-mutacao.lock");
  try {
    const m = await import(pathToFileURL(copia).href);
    fs.rmSync(caminho, { force: true });
    fs.rmSync(`${caminho}.tomada`, { recursive: true, force: true });
    escreverTrincoObsoleto(caminho);
    fs.mkdirSync(`${caminho}.tomada`);
    try {
      await mutacaoTemDeFalhar("M30", async () => {
        const titular = await m.adquirirLockDoFicheiro(caminho, { prazoMs: 0 }).catch(() => null);
        if (titular) await m.libertarLockDoFicheiro(titular);
        assert.equal(titular, null, "com outro processo a tomar o obsoleto, este não entra");
      });
    } finally {
      fs.rmSync(`${caminho}.tomada`, { recursive: true, force: true });
      fs.rmSync(caminho, { force: true });
    }
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("DBG-142 (lente de delta): a reserva deixa de ser confirmada quando outro processo toma o trinco", async () => {
  const caminho = pub.caminhoDoTrincoDePublicacao();
  fs.rmSync(caminho, { force: true });
  const reserva = await pub.reservarPublicacaoEntreProcessos();
  assert.ok(reserva, "livre, a reserva toma-se");
  assert.equal(await reserva.aindaTem(), true, "com o trinco deste processo, a posse confirma-se");
  fs.writeFileSync(caminho, JSON.stringify({ pid: process.pid, em: new Date().toISOString(), token: "outro-titular" }));
  assert.equal(await reserva.aindaTem(), false, "perdido o trinco, a publicação não o confirma");
  await reserva.libertar();
  assert.ok(fs.existsSync(caminho), "a libertação não apaga o trinco de outro titular");
  fs.rmSync(caminho, { force: true });
});

await caso("mutação M31 (DBG-142): a posse dá sempre por confirmada, e a publicação não para quando perde o trinco", async () => {
  const copia = copiaMutada(PUBLICACAO, "M31", "    aindaTem: () => titularAindaTemLock(trinco),", "    aindaTem: async () => true,");
  try {
    const m = await import(pathToFileURL(copia).href);
    const caminho = pub.caminhoDoTrincoDePublicacao();
    fs.rmSync(caminho, { force: true });
    const reserva = await m.reservarPublicacaoEntreProcessos();
    fs.writeFileSync(caminho, JSON.stringify({ pid: process.pid, em: new Date().toISOString(), token: "outro-titular" }));
    try {
      await mutacaoTemDeFalhar("M31", async () => {
        assert.equal(await reserva.aindaTem(), false, "perdido o trinco, a publicação não o confirma");
      });
    } finally {
      await reserva.libertar();
      fs.rmSync(caminho, { force: true });
    }
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("DBG-142 (lente de delta): o motor confirma a posse antes de cada item, e para com erro", () => {
  const texto = fs.readFileSync(path.join(REPO, "lib/importer/shopify/shopifyApprovedSync.server.js"), "utf8");
  assert.match(texto, /if \(opts\.reserva\?\.aindaTem && !\(await opts\.reserva\.aindaTem\(\)\)\) \{\n\s+throw new Error\("Trinco de publicação perdido/);
});

await caso("mutação M32 (DBG-142): o motor não confirma a posse antes de cada item", async () => {
  const texto = fs.readFileSync(path.join(REPO, "lib/importer/shopify/shopifyApprovedSync.server.js"), "utf8");
  const antigo = "        if (opts.reserva?.aindaTem && !(await opts.reserva.aindaTem())) {";
  assert.equal(texto.split(antigo).length - 1, 1, "M32: a âncora tem de existir uma vez");
  const mutado = texto.replace(antigo, "        if (false) {");
  await mutacaoTemDeFalhar("M32", async () => {
    assert.match(mutado, /if \(opts\.reserva\?\.aindaTem && !\(await opts\.reserva\.aindaTem\(\)\)\) \{/);
  });
});

if (falhas) {
  console.error(`\npublicacao-trinco-entre-processos: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\npublicacao-trinco-entre-processos: todos os casos passaram");
