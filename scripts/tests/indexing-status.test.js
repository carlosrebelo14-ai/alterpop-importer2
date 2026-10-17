#!/usr/bin/env node
/* eslint-env node */
/**
 * Tarefa indexing_status e motivos do dry-run da purga (repositório público: sem texto de erro nem SKU).
 *   (a) scripts/maintenance/indexing-status.mjs: uma linha IS:, erro só como classe de lista fechada e tamanho,
 *       valores fora de tokens simples viram "?", sem ficheiro → sem_ficheiro, JSON ilegível → código 2;
 *   (b) maintenance.sh indexing_status com flyctl falso que corre o comando na pasta de teste: o resumo tem
 *       estado, classe e números, e nem o texto do erro nem o SKU saem; execute é recusado sem chamar a Fly;
 *   (c) formatarResumoEpd imprime motivo_<chave>=<n> para cada motivo que retém um item, só contagens.
 * Isolamento: diretórios temporários. Não toca no ficheiro de estado real nem na fila.
 * Uso: node scripts/tests/indexing-status.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatarResumoEpd } from "../maintenance/elite-purge-dry-run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "maintenance", "indexing-status.mjs");
const MAINT = path.join(ROOT, "scripts", "ci", "maintenance.sh");
const SHOP = "jyr17t-wr.myshopify.com";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "indexing-status-"));

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

/** Cria uma pasta de dados com o ficheiro de estado (ou sem ele) e devolve a pasta. */
function dadosComEstado(nome, conteudo) {
  const dir = path.join(tmp, nome);
  fs.mkdirSync(path.join(dir, "data", "catalog-index"), { recursive: true });
  if (conteudo !== undefined) {
    const texto = typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo);
    fs.writeFileSync(path.join(dir, "data", "catalog-index", `${SHOP}-rebuild-status.json`), texto);
  }
  return dir;
}

function correrScript(dir) {
  return spawnSync("node", [SCRIPT, "--data-dir", path.join(dir, "data")], { encoding: "utf8" });
}

console.log("indexing-status — leitura do ficheiro de estado, sem texto de erro");

await check("(a) uma linha IS: com os campos pedidos e classe do erro", async () => {
  const dir = dadosComEstado("a1", {
    state: "failed",
    startedAt: "2026-10-17T08:45:49.000Z",
    finishedAt: "2026-10-17T08:48:11.373Z",
    totalRows: 1234,
    checkpointScanned: 900,
    error: "[fila] espera esgotada: a fila de curadoria está ocupada",
  });
  const r = correrScript(dir);
  assert.equal(r.status, 0, r.stderr);
  const linhas = r.stdout.trim().split("\n");
  assert.equal(linhas.length, 1, "uma linha só");
  assert.equal(
    linhas[0],
    "IS: state=failed startedAt=2026-10-17T08:45:49.000Z finishedAt=2026-10-17T08:48:11.373Z totalRows=1234 checkpointScanned=900 erro=fila erro_tamanho=" +
      "[fila] espera esgotada: a fila de curadoria está ocupada".length
  );
});

await check("(a) o texto do erro não sai: nem SKU, nem frase, só a classe", async () => {
  const dir = dadosComEstado("a2", { state: "failed", error: "SKU ABC-123 ausente do catálogo indexado" });
  const r = correrScript(dir);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /ABC-123|ausente/);
  assert.match(r.stdout, /erro=outra erro_tamanho=\d+/);
});

await check("(a) classes da lista fechada: worker saiu, worker morto, marcador, ilegível", async () => {
  const casos = [
    ["worker process exited with code 0", "worker_saiu"],
    ["worker process killed (SIGTERM)", "worker_morto"],
    ["A indexação não arrancou. Não foi possível marcar a atividade da app (x).", "marcador"],
    ["estado de indexação ilegível", "ilegivel"],
  ];
  for (const [error, classe] of casos) {
    const dir = dadosComEstado(`classe-${classe}`, { state: "failed", error });
    const r = correrScript(dir);
    assert.match(r.stdout, new RegExp(`erro=${classe} `), `${classe} para "${error}"`);
  }
});

await check("(a) sem erro → erro=nenhum, erro_tamanho=0", async () => {
  const dir = dadosComEstado("a3", { state: "completed", error: null, totalRows: 5 });
  const r = correrScript(dir);
  assert.match(r.stdout, /erro=nenhum erro_tamanho=0/);
});

await check("(a) valores fora de token simples viram ?, sem entrar como texto", async () => {
  const dir = dadosComEstado("a4", {
    state: "running; rm -rf /",
    startedAt: "2026-10-17 08:45 \"quebrado\"",
    totalRows: "12 ab",
    checkpointScanned: "9x",
    error: null,
  });
  const r = correrScript(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /state=\? startedAt=\? finishedAt=null totalRows=\? checkpointScanned=\?/);
  assert.doesNotMatch(r.stdout, /rm -rf|quebrado/);
});

await check("(a) sem ficheiro → state=sem_ficheiro, código 0", async () => {
  const dir = dadosComEstado("a5");
  const r = correrScript(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^IS: state=sem_ficheiro /);
});

await check("(a) JSON ilegível ou que não é objeto → código 2, sem conteúdo", async () => {
  for (const [nome, conteudo] of [["a6", "{ truncado"], ["a7", "[1,2]"]]) {
    const dir = dadosComEstado(nome, conteudo);
    const r = correrScript(dir);
    assert.equal(r.status, 2, nome);
    assert.equal(r.stdout, "", nome);
    assert.match(r.stderr, /^IS: erro_leitura=/m);
  }
});

console.log("maintenance.sh indexing_status — resumo com flyctl falso");

/** flyctl falso: corre o comando remoto (argumento 6) na pasta de teste, trocando "cd /app" por ela. */
const fakeFly = path.join(tmp, "flyctl-falso");
fs.writeFileSync(
  fakeFly,
  '#!/usr/bin/env bash\ncmd="${6/cd \\/app/cd $FAKE_ROOT}"\nexec sh -c "$cmd"\n'
);
fs.chmodSync(fakeFly, 0o755);

function correrTarefa(fase, dir) {
  const summary = path.join(tmp, `summary-${fase}-${path.basename(dir)}.md`);
  const r = spawnSync("bash", [MAINT, "indexing_status", fase], {
    encoding: "utf8",
    env: { ...process.env, FLYCTL: fakeFly, FAKE_ROOT: dir, FLY_APP: "teste", GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: "" },
  });
  const resumo = fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "";
  return { r, resumo };
}

await check("(b) resumo: estado, classe e números, sem o texto do erro nem o SKU", async () => {
  const dir = dadosComEstado("b1", {
    state: "failed",
    startedAt: "2026-10-17T08:45:49.000Z",
    finishedAt: "2026-10-17T08:48:11.373Z",
    totalRows: 1234,
    checkpointScanned: 900,
    error: "[fila] espera esgotada: SKU ABC-123",
  });
  const { r, resumo } = correrTarefa("dry-run", dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(resumo, /## Manutenção · `indexing_status` · só leitura/);
  assert.match(resumo, /Estado: \*\*failed\*\*\. Erro: classe \*\*fila\*\*, com \*\*\d+\*\* caracteres/);
  assert.match(resumo, /Linhas \(totalRows; durante uma indexação são os indexados\): \*\*1234\*\*/);
  assert.doesNotMatch(r.stdout + r.stderr + resumo, /ABC-123|espera esgotada/);
});

await check("(b) sem ficheiro: o resumo diz sem_ficheiro e não inventa números", async () => {
  const dir = dadosComEstado("b2");
  const { r, resumo } = correrTarefa("dry-run", dir);
  assert.equal(r.status, 0);
  assert.match(resumo, /Estado: \*\*sem_ficheiro\*\*/);
});

await check("(b) execute é recusado para esta tarefa: código 64 e a Fly não é chamada", async () => {
  const marca = path.join(tmp, "fly-chamada");
  const espiao = path.join(tmp, "flyctl-espiao");
  fs.writeFileSync(espiao, `#!/usr/bin/env bash\ntouch "${marca}"\nexit 0\n`);
  fs.chmodSync(espiao, 0o755);
  const r = spawnSync("bash", [MAINT, "indexing_status", "execute"], {
    encoding: "utf8",
    env: { ...process.env, FLYCTL: espiao, FAKE_ROOT: tmp, FLY_APP: "teste", GITHUB_STEP_SUMMARY: "/dev/null", GITHUB_OUTPUT: "" },
  });
  assert.equal(r.status, 64);
  assert.equal(fs.existsSync(marca), false, "a Fly não foi chamada");
});

console.log("formatarResumoEpd — motivos que retêm um item");

await check("(c) uma linha motivo_<chave>=<n> por motivo, só contagens", async () => {
  const linhas = formatarResumoEpd({
    before: 10,
    candidatos: 2,
    retidos: 3,
    retidosPorMotivo: { publicado_ou_erro: 1, apagado_no_admin: 1, reset: 0, decisao_humana: 1 },
    candidatosPorEstado: {},
    retidosPorEstado: {},
  });
  assert.ok(linhas.includes("EPD: motivo_publicado_ou_erro=1"));
  assert.ok(linhas.includes("EPD: motivo_apagado_no_admin=1"));
  assert.ok(linhas.includes("EPD: motivo_reset=0"));
  assert.ok(linhas.includes("EPD: motivo_decisao_humana=1"));
  assert.ok(linhas.includes("EPD: motivo_sem_entrada=0"), "sem_entrada também conta, para a soma bater");
  assert.ok(linhas.includes("EPD: motivo_sem_origem=0"), "sem_origem também conta, para a soma bater");
  for (const l of linhas) assert.match(l, /^EPD: [A-Za-z_]+=\d+$/, l);
});

fs.rmSync(tmp, { recursive: true, force: true });

if (falhas) {
  console.error(`\nindexing-status: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nindexing-status: todos os casos passaram");
