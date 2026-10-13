#!/usr/bin/env node
/* eslint-env node */
/**
 * Workflow maintenance + scripts/ci/maintenance.sh, com um flyctl falso no PATH (sem rede):
 *   - lista fechada de tarefas e fases; nada fora dela corre;
 *   - dry-run por omissão; execute só nas tarefas que escrevem e só depois do dry-run, com o
 *     environment production no job de execute;
 *   - catalog_health espera pela indexação e repete (até 15 min) antes de avaliar;
 *   - o db_push execute recusa-se com indexação a decorrer; o dry-run do db_push não escreve;
 *   - resumo em português no GITHUB_STEP_SUMMARY.
 * Uso: node scripts/tests/maintenance.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/ci/maintenance.sh");
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

console.log("maintenance.yml — texto");
const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/maintenance.yml"), "utf8");
const code = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
check("só workflow_dispatch, só main", () => {
  assert.match(code, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(code, /^\s+(push|pull_request|schedule):/m);
  assert.equal([...code.matchAll(/github\.ref == 'refs\/heads\/main'/g)].length, 2);
});
check("task: lista fechada exata", () => {
  assert.match(
    code,
    /task:\n\s+description: .*\n\s+type: choice\n\s+required: true\n\s+options:\n\s+- catalog_health\n\s+- diagnose_theme\n\s+- diagnose_characters\n\s+- tags_cleanup\n\s+- character_pages_sync\n\s+- db_push\n\s+mode:/
  );
});
check("mode: dry-run por omissão, execute", () => {
  assert.match(code, /mode:\n\s+description: .*\n\s+type: choice\n\s+default: dry-run\n\s+options:\n\s+- dry-run\n\s+- execute/);
});
check("o job dry-run não tem environment e corre sempre em fase dry-run", () => {
  const job = code.slice(code.indexOf("  dry-run:"), code.indexOf("  execute:"));
  assert.doesNotMatch(job, /environment:/);
  assert.match(job, /maintenance\.sh "\$TASK" dry-run/);
  assert.doesNotMatch(job, /\bexecute\b/);
});
check("o job execute: needs dry-run, environment production, só mode=execute nas tarefas que escrevem", () => {
  const job = code.slice(code.indexOf("  execute:"));
  assert.match(job, /needs: dry-run/);
  assert.match(job, /environment: production/);
  assert.match(job, /inputs\.mode == 'execute'/);
  assert.match(job, /\["tags_cleanup","character_pages_sync","db_push"\]/);
  assert.match(job, /maintenance\.sh "\$TASK" execute/);
});
check("nenhum texto livre vai para comandos; token só por secrets.FLY_API_TOKEN; sem flags de loja", () => {
  assert.doesNotMatch(code, /\$\{\{\s*(github\.event|github\.head_ref)/);
  assert.equal([...code.matchAll(/secrets\./g)].length, 2); // um por job
  assert.doesNotMatch(code, /PRICE_MODE|THEME_GUARD|accept-data-loss/);
});

console.log("maintenance.sh — comandos fixos");
const sh = fs.readFileSync(SCRIPT, "utf8");
check("sem --accept-data-loss; db:push só em npm run db:push; execute só nos três comandos que escrevem", () => {
  assert.doesNotMatch(sh, /accept-data-loss/);
  assert.equal([...sh.matchAll(/--execute"/g)].length, 2);
  assert.equal([...sh.matchAll(/npm run db:push/g)].length, 1);
  assert.doesNotMatch(sh, /--include-locked|--all-statuses/);
});

// flyctl falso: regista os comandos e responde conforme as variáveis FAKE_*.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-"));
  const bin = path.join(dir, "flyctl");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
cmd="$6"
echo "$cmd" >> "$FAKE_LOG"
case "$cmd" in
  *base64*)
    n=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$FAKE_COUNT"
    if [ "$n" -le "\${FAKE_INDEXING_CALLS:-0}" ]; then echo "[check-no-indexing] INDEXAÇÃO A DECORRER. O db:push não corre"; exit 1; fi
    if [ -n "$FAKE_PROBE_ERROR" ]; then echo "[check-no-indexing] não consegui ler"; exit 2; fi
    echo "[check-no-indexing] nenhuma indexação a decorrer."; exit 0;;
  *"npm run catalog:health"*)
    printf '  ✓ V3  ok\\n  ✗ V5  total — esperado x, obtido y\\n  ! V11  aviso\\n'; exit "\${FAKE_HEALTH_RC:-0}";;
  *"migrate diff"*) echo "-- CreateTable"; exit "\${FAKE_DIFF_RC:-2}";;
  *tags-cleanup*) echo "produtos lidos: 57 · limpos: 0 · a limpar: 57 (179 tag(s))"; exit "\${FAKE_RC:-0}";;
  *character-pages-sync*) printf '  update     darth-vader  Star Wars  24 produtos\\n  create     grogu  Star Wars  7 produtos\\n'; exit "\${FAKE_RC:-0}";;
  *) echo "ran: $cmd"; exit "\${FAKE_RC:-0}";;
esac
`,
    { mode: 0o755 }
  );
  return { dir, bin, log: path.join(dir, "log"), count: path.join(dir, "count"), summary: path.join(dir, "summary.md") };
}
function run(task, phase, env = {}) {
  const t = setup();
  const r = spawnSync("bash", [SCRIPT, task, phase], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      FLYCTL: t.bin,
      FAKE_LOG: t.log,
      FAKE_COUNT: t.count,
      GITHUB_STEP_SUMMARY: t.summary,
      WAIT_STEP_SECONDS: "0",
      WAIT_MAX_ATTEMPTS: "3",
      ...env,
    },
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  return { ...r, calls: read(t.log).split("\n").filter(Boolean), summaryText: read(t.summary), probes: Number(read(t.count) || 0) };
}
const ran = (r, needle) => r.calls.some((c) => c.includes(needle));

check("tarefa ou fase fora da lista → recusa sem tocar na Fly", () => {
  for (const [t, p] of [["rm_rf", "dry-run"], ["tags_cleanup", "yolo"], ["", ""], ["tags_cleanup; ls", "dry-run"]]) {
    const r = run(t, p);
    assert.equal(r.status, 64, `${t}/${p}`);
    assert.equal(r.calls.length, 0);
  }
});
check("tags_cleanup dry-run: sem --execute, só lista; execute: com --execute", () => {
  let r = run("tags_cleanup", "dry-run");
  assert.equal(r.status, 0);
  assert.ok(ran(r, "node scripts/catalog/tags-cleanup.js'"));
  assert.ok(!ran(r, "--execute"));
  r = run("tags_cleanup", "execute");
  assert.ok(ran(r, "node scripts/catalog/tags-cleanup.js --execute"));
});
check("character_pages_sync: dry-run sem --execute, execute com", () => {
  let r = run("character_pages_sync", "dry-run");
  assert.ok(!ran(r, "--execute"));
  assert.match(r.summaryText, /update {5}darth-vader/);
  assert.match(r.summaryText, /2 ações/);
  r = run("character_pages_sync", "execute");
  assert.ok(ran(r, "character-pages-sync.js --execute"));
});
check("tarefas só de leitura ignoram execute: nunca correm comandos de escrita", () => {
  for (const task of ["catalog_health", "diagnose_theme", "diagnose_characters"]) {
    const r = run(task, "execute");
    assert.ok(!r.calls.some((c) => /--execute|db:push|migrate/.test(c)), task);
    assert.match(r.summaryText, /não se aplica a esta tarefa/);
  }
});
check("diagnose_theme corre os dois comandos de leitura; diagnose_characters o cat e o dry-run", () => {
  let r = run("diagnose_theme", "dry-run");
  assert.ok(ran(r, "print-access-scopes.js") && ran(r, "theme-contract-status.js"));
  r = run("diagnose_characters", "dry-run");
  assert.ok(ran(r, "character-pages-cycle-state.json") && ran(r, "character-pages-sync.js"));
  assert.ok(!ran(r, "--execute"));
});

console.log("catalog_health — espera pela indexação");
check("sem indexação: avalia logo (1 sondagem)", () => {
  const r = run("catalog_health", "dry-run");
  assert.equal(r.status, 0);
  assert.equal(r.probes, 1);
  assert.match(r.summaryText, /1 verdes, 1 vermelhas, 1 avisos/);
});
check("indexação nas 2 primeiras sondagens: espera, repete e só avalia à 3.ª", () => {
  const r = run("catalog_health", "dry-run", { FAKE_INDEXING_CALLS: "2" });
  assert.equal(r.status, 0);
  assert.equal(r.probes, 3);
  const calls = r.calls;
  const lastProbe = calls.map((c, i) => (c.includes("base64") ? i : -1)).filter((i) => i >= 0).pop();
  const health = calls.findIndex((c) => c.includes("catalog:health"));
  assert.ok(health > lastProbe, "o portão tem de correr depois da última sondagem");
});
check("indexação até ao fim do tempo: avalia na mesma e avisa que V5, V6, V7 e V17 podem estar errados", () => {
  const r = run("catalog_health", "dry-run", { FAKE_INDEXING_CALLS: "99" });
  assert.equal(r.probes, 3);
  assert.ok(ran(r, "catalog:health"));
  assert.match(r.summaryText, /V5, V6, V7 e V17 podem estar errados/);
});
check("estado da indexação ilegível: o portão não corre (falha fechada)", () => {
  const r = run("catalog_health", "dry-run", { FAKE_PROBE_ERROR: "1" });
  assert.equal(r.status, 2);
  assert.ok(!ran(r, "catalog:health"));
});
check("portão vermelho → código 1 e vermelhas listadas no resumo, em português", () => {
  const r = run("catalog_health", "dry-run", { FAKE_HEALTH_RC: "1" });
  assert.equal(r.status, 1);
  assert.match(r.summaryText, /Resultado:\*\* ❌ Falhou \(código 1\)/);
  assert.match(r.summaryText, /Vermelhas:/);
  assert.match(r.summaryText, /V5 {2}total/);
});
check("o tempo de espera por omissão é 15 min (15 sondagens de 60 s)", () => {
  assert.match(sh, /WAIT_STEP="\$\{WAIT_STEP_SECONDS:-60\}"/);
  assert.match(sh, /15 \* 60/);
});

console.log("db_push");
check("dry-run: só migrate diff (sem db:push), SQL diferente é sucesso", () => {
  let r = run("db_push", "dry-run");
  assert.equal(r.status, 0);
  assert.ok(ran(r, "prisma migrate diff") && !ran(r, "npm run db:push"));
  assert.match(r.summaryText, /difere/);
  r = run("db_push", "dry-run", { FAKE_DIFF_RC: "0" });
  assert.equal(r.status, 0);
  assert.match(r.summaryText, /Sem alterações/);
  r = run("db_push", "dry-run", { FAKE_DIFF_RC: "1" });
  assert.equal(r.status, 1);
});
check("execute sem indexação: npm run db:push", () => {
  const r = run("db_push", "execute");
  assert.equal(r.status, 0);
  assert.ok(ran(r, "npm run db:push"));
});
check("execute com indexação a decorrer o tempo todo: não corre db:push e falha", () => {
  const r = run("db_push", "execute", { FAKE_INDEXING_CALLS: "99" });
  assert.equal(r.status, 1);
  assert.ok(!ran(r, "db:push"));
  assert.match(r.summaryText, /O db:push não correu/);
});
check("execute com indexação que acaba durante a espera: corre db:push", () => {
  const r = run("db_push", "execute", { FAKE_INDEXING_CALLS: "1" });
  assert.equal(r.status, 0);
  assert.ok(ran(r, "npm run db:push"));
});
check("execute com estado ilegível: não corre db:push", () => {
  const r = run("db_push", "execute", { FAKE_PROBE_ERROR: "1" });
  assert.equal(r.status, 2);
  assert.ok(!ran(r, "db:push"));
});

console.log("resumo");
check("resumo em português com tarefa, modo, resultado, o que faz e saída", () => {
  const r = run("tags_cleanup", "dry-run");
  for (const frag of ["## Manutenção · `tags_cleanup` · dry-run (não escreve)", "**Resultado:** ✅ Concluída sem erros", "**O que faz:**", "Não escreve na loja", "<details><summary>Saída"]) {
    assert.ok(r.summaryText.includes(frag), frag);
  }
  assert.match(r.summaryText, /produtos lidos: 57/);
  const e = run("tags_cleanup", "execute");
  assert.match(e.summaryText, /execute \(escreve\)/);
});
check("GITHUB_OUTPUT recebe a linha-chave do dry-run para o job execute", () => {
  const t = setup();
  const out = path.join(t.dir, "out");
  spawnSync("bash", [SCRIPT, "tags_cleanup", "dry-run"], {
    cwd: ROOT, encoding: "utf8",
    env: { PATH: process.env.PATH, FLYCTL: t.bin, FAKE_LOG: t.log, FAKE_COUNT: t.count, GITHUB_STEP_SUMMARY: t.summary, GITHUB_OUTPUT: out },
  });
  assert.match(fs.readFileSync(out, "utf8"), /key=produtos lidos: 57/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nmaintenance: todos os casos passaram");
