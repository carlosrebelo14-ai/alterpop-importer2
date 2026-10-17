#!/usr/bin/env node
/* eslint-env node */
/**
 * .github/workflows/deploy.yml e scripts/maintenance/check-no-indexing.mjs.
 *
 * Parte 1, texto do workflow: sem --accept-data-loss, sem PRICE_MODE/THEME_GUARD fora de comentários,
 * token só por secrets.FLY_API_TOKEN, environment production, catalog:health e db:push pelo script
 * de manutenção (que espera pela indexação).
 * Parte 2, o script de verificação de indexação com ficheiros de estado falsos, um deles escrito pelo
 * flushCatalogRebuildStatus real (o mesmo que o V16 lê).
 * O workflow maintenance e o scripts/ci/maintenance.sh têm o seu teste em maintenance.test.js.
 * Uso: node scripts/tests/deploy-workflow.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "deploy.yml");
const CHECK = path.join(ROOT, "scripts", "maintenance", "check-no-indexing.mjs");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const yml = fs.readFileSync(WORKFLOW, "utf8");
const code = yml
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");
/** Bloco `- name: <title>`/`- uses: ...` do passo, até ao próximo passo. */
function step(marker) {
  const parts = code.split(/\n(?= {6}- )/);
  const found = parts.find((p) => p.includes(marker));
  assert.ok(found, `passo "${marker}" não encontrado`);
  return found;
}

console.log("deploy.yml — texto");
check("só workflow_dispatch, a partir de main", () => {
  assert.match(code, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(code, /^\s+(push|pull_request|schedule):/m);
  assert.match(code, /if: github\.ref == 'refs\/heads\/main'/);
});
check("o job usa o environment production", () => assert.match(code, /runs-on: ubuntu-latest\n {4}environment: production/));
check("só o input skip_deploy; os modos de manutenção vivem no workflow maintenance", () => {
  assert.match(code, /skip_deploy:\n\s+description: .*\n\s+type: boolean\n\s+default: false/);
  for (const gone of ["db_push_only", "diagnose_", "tags_cleanup"]) assert.doesNotMatch(code, new RegExp(gone));
});
check("nunca --accept-data-loss", () => assert.doesNotMatch(code, /accept-data-loss/));
check("nem PRICE_MODE nem THEME_GUARD fora de comentários", () => {
  assert.doesNotMatch(code, /PRICE_MODE/);
  assert.doesNotMatch(code, /THEME_GUARD/);
});
check("token só por secrets.FLY_API_TOKEN", () => {
  assert.equal([...code.matchAll(/secrets\./g)].length, 1);
  assert.match(code, /FLY_API_TOKEN: \$\{\{ secrets\.FLY_API_TOKEN \}\}/);
});
check("skip_deploy salta deploy, npm ci e prisma generate", () => {
  for (const marker of ["actions/setup-node", "npm ci", "prisma generate", "esperar_indexacao", "scripts/deploy.sh"]) {
    assert.match(step(marker), /if: env\.SKIP_DEPLOY != 'true'/, marker);
  }
});
check("espera por indexação antes do flyctl deploy (DBG-156): o passo chama esperar_indexacao, sem continue-on-error", () => {
  assert.match(step("esperar_indexacao"), /run: bash scripts\/ci\/maintenance\.sh esperar_indexacao dry-run/);
  assert.doesNotMatch(step("esperar_indexacao"), /continue-on-error/);
  assert.ok(code.indexOf("setup-flyctl") < code.indexOf("esperar_indexacao"), "o flyctl tem de estar instalado antes da espera");
  assert.ok(code.indexOf("esperar_indexacao") < code.indexOf("scripts/deploy.sh"), "a espera tem de vir antes do deploy");
});
check("catalog:health na Fly depois do deploy; nenhum db:push no deploy (Decisão 34: o esquema muda só pelo maintenance)", () => {
  const health = step("catalog_health dry-run");
  assert.match(health, /bash scripts\/ci\/maintenance\.sh catalog_health dry-run/);
  assert.doesNotMatch(code, /db_push|db:push/);
  assert.doesNotMatch(step("setup-flyctl"), /\bif:/);
});
check("a verificação não importa Prisma nem código da app", () => {
  const src = fs.readFileSync(CHECK, "utf8");
  assert.doesNotMatch(src, /from\s+["'](?!node:)/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//, ""), /@prisma|PrismaClient|lib\/importer/);
});

console.log("check-no-indexing.mjs — ficheiros de estado");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "no-indexing-"));
const SHOP = "deploy-workflow-test.myshopify.com";
function run(statusFile, extra = []) {
  const data = path.join(tmp, "data");
  fs.rmSync(data, { recursive: true, force: true });
  if (statusFile !== undefined) {
    fs.mkdirSync(path.join(data, "catalog-index"), { recursive: true });
    const f = path.join(data, "catalog-index", `${SHOP}-rebuild-status.json`);
    if (statusFile.raw !== undefined) fs.writeFileSync(f, statusFile.raw);
    if (statusFile.dir) {
      fs.rmSync(f, { force: true });
      fs.mkdirSync(f);
    }
    if (statusFile.ageMin) {
      const t = new Date(Date.now() - statusFile.ageMin * 60000);
      fs.utimesSync(f, t, t);
    }
  }
  // Como em produção: o script entra por stdin, o cwd é a raiz da app.
  return spawnSync(process.execPath, ["--input-type=module", "-", "--shop", SHOP, ...extra], {
    cwd: tmp,
    input: fs.readFileSync(CHECK, "utf8"),
    encoding: "utf8",
  });
}
const out = (r) => `${r.stdout}${r.stderr}`;

check("sem ficheiro de estado (ENOENT) → passa", () => {
  const r = run(undefined);
  assert.equal(r.status, 0, out(r));
});
for (const state of ["completed", "failed", "interrupted", "idle"]) {
  check(`state "${state}" → passa`, () => {
    const r = run({ raw: JSON.stringify({ state, indexing: false }) });
    assert.equal(r.status, 0, out(r));
  });
}
check('state "running" → falha (exit 1) e diz que o db:push não corre', () => {
  const r = run({ raw: JSON.stringify({ state: "running", indexing: true, startedAt: "2026-10-13T10:00:00Z", scanned: 120, totalRows: 900 }) });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /INDEXAÇÃO A DECORRER/);
  assert.match(r.stderr, /scanned=120\/900/);
});
check("indexing true com outro state → falha (mesmo critério do V16)", () => {
  const r = run({ raw: JSON.stringify({ state: "failed", indexing: true }) });
  assert.equal(r.status, 1, out(r));
});
check("running com ficheiro parado há 2 h → falha e avisa que pode estar preso", () => {
  const r = run({ raw: JSON.stringify({ state: "running", indexing: true }), ageMin: 120 });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /pode ser um estado preso/);
});
check("JSON ilegível → falha fechada (exit 2), nunca 'sem indexação'", () => {
  const r = run({ raw: "{ não é json" });
  assert.equal(r.status, 2, out(r));
});
check("erro de leitura que não é ENOENT → falha fechada (exit 2)", () => {
  const r = run({ dir: true });
  assert.equal(r.status, 2, out(r));
});
check("--data-dir aponta para outro volume", () => {
  const r = run(undefined, ["--data-dir", path.join(tmp, "outro")]);
  assert.equal(r.status, 0, out(r));
});

console.log("check-no-indexing.mjs — ficheiro escrito pelo código real da app");
{
  process.env.DATABASE_URL ||= "file:/tmp/deploy-workflow-test.sqlite";
  const { flushCatalogRebuildStatus } = await import(
    path.join(ROOT, "lib/importer/catalog/catalogRebuildStatus.server.js")
  );
  const { getDefaultConfig } = await import(path.join(ROOT, "lib/importer/config.js"));
  const realDir = path.join(getDefaultConfig().paths.data, "catalog-index");
  const realFile = path.join(realDir, `${SHOP}-rebuild-status.json`);
  const existed = fs.existsSync(realFile);
  try {
    assert.ok(!existed, "ficheiro de teste já existia");
    for (const [status, expected] of [
      [{ state: "running", indexing: true, startedAt: new Date().toISOString(), scanned: 5, totalRows: 10 }, 1],
      [{ state: "completed", indexing: false, finishedAt: new Date().toISOString() }, 0],
    ]) {
      await flushCatalogRebuildStatus(SHOP, status);
      check(`flushCatalogRebuildStatus(${status.state}) → exit ${expected}`, () => {
        const r = spawnSync(process.execPath, ["--input-type=module", "-", "--shop", SHOP, "--data-dir", getDefaultConfig().paths.data], {
          cwd: tmp,
          input: fs.readFileSync(CHECK, "utf8"),
          encoding: "utf8",
        });
        assert.equal(r.status, expected, out(r));
      });
    }
  } finally {
    if (!existed) fs.rmSync(realFile, { force: true });
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ndeploy-workflow: todos os casos passaram");
