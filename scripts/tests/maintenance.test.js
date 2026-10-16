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
    /task:\n\s+description: .*\n\s+type: choice\n\s+required: true\n\s+options:\n\s+- catalog_health\n\s+- diagnose_theme\n\s+- diagnose_characters\n\s+- price_check\n\s+- volume_snapshot\n\s+- tags_cleanup\n\s+- character_pages_sync\n\s+- db_push\n\s+- db_flag_check\n\s+- logs_recent\n\s+- restore_dry_run\n\s+- active_vs_queue\n\s+mode:/
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
  assert.match(job, /\["volume_snapshot","tags_cleanup","character_pages_sync","db_push"\]/);
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
if [ "$1" = "volumes" ]; then
  echo "$*" >> "$FAKE_LOG"
  n=$(cat "$FAKE_SNAPS" 2>/dev/null || echo 2)
  case "$*" in
    "volumes list"*) if [ "\${FAKE_VOLS:-1}" = "1" ]; then echo '[{"id":"vol_segredo123","name":"data","state":"created","region":"mad"}]'; else echo '[{"id":"vol_a"},{"id":"vol_b"}]'; fi; exit 0;;
    "volumes snapshots list"*) if [ "$n" = "2" ]; then echo '[{"id":"vs_0"},{"id":"vs_1"}]'; else echo '[{"id":"vs_0"},{"id":"vs_1"},{"id":"vs_2"}]'; fi; exit 0;;
    "volumes snapshots create"*) if [ -n "$FAKE_SNAP_FAIL" ]; then echo "Error: unauthorized token"; exit 1; fi; echo $((n+1)) > "$FAKE_SNAPS"; echo "snapshot vs_new"; exit 0;;
  esac
fi
if [ "$1" = "logs" ]; then echo "logs $*" >> "$FAKE_LOG"; printf '%b\\n' "$FAKE_LOGS"; exit "\${FAKE_LOGS_RC:-0}"; fi
if [ "$1" = "ssh" ] && [ "$2" = "sftp" ]; then
  echo "sftp $*" >> "$FAKE_LOG"
  case "$4" in
    *-wal) if [ "$FAKE_WAL" = "present" ] && [ -z "$FAKE_WAL_FAIL" ]; then : > "$5"; exit 0; fi; exit 1;;
  esac
  if [ -n "$FAKE_DB" ]; then cp "$FAKE_DB" "$5"; exit 0; fi
  exit 1
fi
cmd="$6"
echo "$cmd" >> "$FAKE_LOG"
case "$cmd" in
  *DB_DEGRADED*)
    case "\${FAKE_FLAG:-absent}" in
      present) echo FLAG_PRESENT; exit 0;;
      unknown) echo "ssh: falhou"; exit 1;;
      *) echo FLAG_ABSENT; exit 0;;
    esac;;
  *dev.sqlite-wal*)
    case "$FAKE_WAL" in
      present) echo WAL_PRESENT; exit 0;;
      unknown) echo "ssh: falhou"; exit 1;;
      *) echo WAL_ABSENT; exit 0;;
    esac;;
  *base64*)
    b=$(echo "$cmd" | cut -d' ' -f7)
    if echo "$b" | base64 -d 2>/dev/null | grep -q "escrita:"; then
      printf 'ERRO: escrita: metaobjectUpsert(…): Products cannot be blank\\n'; exit 0
    fi
    n=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$FAKE_COUNT"
    if [ "$n" -le "\${FAKE_INDEXING_CALLS:-0}" ]; then echo "[check-no-indexing] INDEXAÇÃO A DECORRER. O db:push não corre"; exit 1; fi
    if [ -n "$FAKE_PROBE_ERROR" ]; then echo "[check-no-indexing] não consegui ler"; exit 2; fi
    echo "[check-no-indexing] nenhuma indexação a decorrer."; exit 0;;
  *"npm run catalog:health"*)
    printf '  ✓ V3  produtos APPROVED = 0\n  ✗ V5  total — esperado 8435450233067, obtido darth-vader\n  ! V11  gid://shopify/Product/123 a 9,99 €\n'; exit "\${FAKE_HEALTH_RC:-0}";;
  *"migrate diff"*) printf 'CREATE TABLE "Segredo" (preco 9,99);\nCREATE UNIQUE INDEX "x" ON "Segredo"(a);\n'; exit "\${FAKE_DIFF_RC:-2}";;
  *price-check*)
    printf 'PC: regra_servidor=LEGACY\\nPC: impostos_incluidos=true\\nPC: publicados=57\\nPC: conformes_net=0\\nPC: a_atualizar=50\\nPC: sobem=0\\nPC: descem=50\\nPC: mediana_diff_pct=-17.4\\nPC: banda_ate_1=0\\nPC: banda_1_a_5=2\\nPC: banda_5_a_15=3\\nPC: banda_acima_15=45\\nPC: fora_preco_manual=4\\nPC: manual_override=3\\nPC: manual_detetado=1\\nPC: trancados=0\\nPC: sem_registo=1\\nPC: outros_ignorados=0\\nPC: falhados=1\\nPC: nao_encontrados=1\\n'; exit "\${FAKE_RC:-0}";;
  *tags-cleanup*)
    printf 'produtos lidos: 57 · limpos: 0 · a limpar: 57 (179 tag(s)) · sync_locked de fora: 0\ntags distintas fora da lista: 2\n    57  new-arrival\n    40  Funko\n  star-wars-darth-vader SKU 8435450233067 9,99 €\nreleitura: 57 produto(s) · com tags fora da lista (sem contar sync_locked excluídos): 0\n'; exit "\${FAKE_RC:-0}";;
  *character-pages-sync*) printf '  update     darth-vader  Star Wars  24 produtos\n  create     grogu  Star Wars  7 produtos gid://shopify/Metaobject/1\nalterpop.character escrito em 31 produto(s)\n'; exit "\${FAKE_RC:-0}";;
  *print-access-scopes*) printf '[print-access-scopes] 15 scope(s) concedido(s) em loja-secreta.myshopify.com:\n  - read_themes\n[print-access-scopes] read_themes: concedido\n'; exit "\${FAKE_RC:-0}";;
  *theme-contract-status*) printf '{"ok":true,"enforced":true,"status":"ok","blocking":0,"warnings":1,"checkedAt":"2026-10-13T00:00:00Z","erro":false}\n'; exit "\${FAKE_RC:-0}";;
  *character-cycle-summary*) printf '{"status":"yellow","ranAt":"2026-10-09T10:00:00Z","toApply_n":8}\n'; exit "\${FAKE_RC:-0}";;
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
      FAKE_SNAPS: path.join(t.dir, "snaps"),
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
const SO_LEITURA_NOVA = ["db_flag_check", "logs_recent", "restore_dry_run"];

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
  assert.match(r.summaryText, /1 criar, 1 atualizar/);
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
  assert.ok(ran(r, "print-access-scopes.js") && ran(r, "theme-contract-status.js --summary"));
  assert.match(r.summaryText, /read_themes: \*\*concedido\*\*/);
  assert.match(r.summaryText, /enforced = true/);
  r = run("diagnose_characters", "dry-run");
  assert.ok(ran(r, "character-cycle-summary.js") && ran(r, "character-pages-sync.js"));
  assert.ok(!r.calls.some((c) => c.includes("cat /app")));
  assert.match(r.summaryText, /Erros do último ciclo \(sem handles nem GIDs\):\n {2}- escrita: metaobjectUpsert\(…\): Products cannot be blank/);
  assert.doesNotMatch(r.stdout, /frodo|gid:\/\//);
  assert.ok(!ran(r, "--execute"));
});

check("volume_snapshot: dry-run só lê (lista volume e snapshots); execute cria 1 snapshot e mostra antes/depois", () => {
  let r = run("volume_snapshot", "dry-run");
  assert.equal(r.status, 0);
  assert.ok(ran(r, "volumes list") && ran(r, "volumes snapshots list"));
  assert.ok(!ran(r, "snapshots create"));
  assert.match(r.summaryText, /Volumes da app: \*\*1\*\*\. Snapshots existentes antes: \*\*2\*\*/);
  assert.match(r.summaryText, /só leitura|dry-run \(não escreve\)/);
  r = run("volume_snapshot", "execute");
  assert.equal(r.status, 0);
  assert.ok(ran(r, "volumes snapshots create"));
  assert.match(r.summaryText, /execute \(escreve\)/);
  assert.match(r.summaryText, /Snapshots depois do pedido: \*\*3\*\*/);
});
check("volume_snapshot: mais de um volume ou erro de autorização → falha sem criar nada", () => {
  let r = run("volume_snapshot", "execute", { FAKE_VOLS: "2" });
  assert.equal(r.status, 3);
  assert.ok(!ran(r, "snapshots create"));
  assert.match(r.summaryText, /exatamente 1 volume e encontrei 2/);
  r = run("volume_snapshot", "execute", { FAKE_SNAP_FAIL: "1" });
  assert.equal(r.status, 1);
  assert.match(r.summaryText, /autorização da Fly/);
});
check("price_check: só leitura, resumo em português com impostos, regra e contagens", () => {
  const r = run("price_check", "execute"); // execute não se aplica: é só leitura
  assert.equal(r.status, 0);
  assert.ok(ran(r, "node scripts/maintenance/price-check.js"));
  assert.ok(!r.calls.some((c) => /--execute|db:push|migrate/.test(c)));
  assert.match(r.summaryText, /Regra do servidor \(PRICE_MODE\): \*\*LEGACY\*\*\. Impostos incluídos nos preços \(taxesIncluded\): \*\*true\*\*/);
  assert.match(r.summaryText, /Estado coerente de \*\*antes\*\* da troca/);
  assert.match(r.summaryText, /Publicados lidos: \*\*57\*\*; já conformes com a regra NET: \*\*0\*\*; a atualizar: \*\*50\*\*/);
  assert.match(r.summaryText, /Ficam fora por preço manual: \*\*4\*\* \(override da curadoria 3, preço detetado 1\)/);
  assert.match(r.summaryText, /não se aplica a esta tarefa/);
});
check("price_check: avisa nos estados intermédios da troca", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-"));
  const bin = path.join(dir, "flyctl");
  const out = (rule, taxes) => `#!/bin/sh\nprintf 'PC: regra_servidor=${rule}\\nPC: impostos_incluidos=${taxes}\\nPC: publicados=1\\nPC: a_atualizar=0\\nPC: fora_preco_manual=0\\n'\n`;
  for (const [rule, taxes, rx] of [["NET", "true", /Estado intermédio: regra NET com impostos incluídos/], ["LEGACY", "false", /Estado intermédio: regra antiga/], ["NET", "false", /Estado coerente de \*\*depois\*\*/]]) {
    fs.writeFileSync(bin, out(rule, taxes), { mode: 0o755 });
    const summary = path.join(dir, `s-${rule}-${taxes}.md`);
    spawnSync("bash", [SCRIPT, "price_check", "dry-run"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, FLYCTL: bin, GITHUB_STEP_SUMMARY: summary } });
    assert.match(fs.readFileSync(summary, "utf8"), rx, `${rule}/${taxes}`);
  }
});

console.log("catalog_health — espera pela indexação");
check("sem indexação: avalia logo (1 sondagem)", () => {
  const r = run("catalog_health", "dry-run");
  assert.equal(r.status, 0);
  assert.equal(r.probes, 1);
  assert.match(r.summaryText, /1 verdes, 1 vermelhas, 1 avisos/);
  assert.match(r.summaryText, /Vermelhas: V5/);
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
check("indexação até ao fim do tempo: falha sem avaliar o portão, 'catálogo a indexar, repetir'", () => {
  const r = run("catalog_health", "dry-run", { FAKE_INDEXING_CALLS: "99" });
  assert.equal(r.status, 75);
  assert.equal(r.probes, 3);
  assert.ok(!ran(r, "catalog:health"), "o portão não pode correr a meio da indexação");
  assert.match(r.summaryText, /Catálogo a indexar, repetir/);
  assert.doesNotMatch(r.summaryText, /verdes/);
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
  assert.match(r.summaryText, /Vermelhas: V5/);
  assert.match(r.summaryText, /o portão correu e tem verificações vermelhas/);
  assert.doesNotMatch(r.summaryText, /não consegui ligar à Fly/);
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
  assert.match(r.summaryText, /difere.*1 tabelas a criar, 0 alterações de tabela, 1 índices a criar/);
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

console.log("repositório público: logs e resumos só com contagens e estados");
const PROIBIDO = [/vol_/, /vs_/, /8435450233067/, /darth-vader/, /gid:\/\/shopify/, /9,99/, /€/, /star-wars-/, /loja-secreta/, /Segredo/, /"checkedAt"/];
check("nenhuma tarefa/fase deixa SKU, handle, preço, GID ou JSON completo no log nem no resumo", () => {
  for (const task of ["catalog_health", "diagnose_theme", "diagnose_characters", "price_check", "volume_snapshot", "tags_cleanup", "character_pages_sync", "db_push", "db_flag_check", "logs_recent", "restore_dry_run"]) {
    for (const phase of SO_LEITURA_NOVA.includes(task) ? ["dry-run"] : ["dry-run", "execute"]) {
      const r = run(task, phase);
      const visivel = `${r.stdout}\n${r.stderr}\n${r.summaryText}`;
      for (const rx of PROIBIDO) assert.doesNotMatch(visivel, rx, `${task}/${phase} expõe ${rx}`);
      assert.ok(visivel.length > 50, `${task}/${phase} sem resumo`);
    }
  }
});
check("em falha, nenhum texto bruto: só a causa classificada", () => {
  const r = run("tags_cleanup", "execute", { FAKE_RC: "1" });
  assert.equal(r.status, 1);
  assert.match(r.summaryText, /Causa provável:/);
  for (const rx of PROIBIDO) assert.doesNotMatch(`${r.stdout}${r.stderr}${r.summaryText}`, rx);
});
check("o script nunca escreve a saída bruta no log (sem tee nem cat do ficheiro de saída)", () => {
  const exec = sh.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(exec, /\btee\b/);
  assert.doesNotMatch(exec, /cat "\$OUT"|(^|[|;&(])\s*tail\s.*\$OUT/m); // "--no-tail" não é o comando tail
  assert.match(exec, />>"\$OUT" 2>&1/);
});
check("o workflow maintenance e o deploy usam o mesmo grupo de concorrência, sem cancelar", () => {
  const dep = fs.readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8");
  const group = (t) => t.match(/concurrency:\n\s+group: (\S+)\n\s+cancel-in-progress: (\w+)/);
  assert.deepEqual(group(yml).slice(1), ["deploy-production", "false"]);
  assert.deepEqual(group(dep).slice(1), ["deploy-production", "false"]);
});

check("Fly com código antigo (sem --summary): só enforced/status, nunca o JSON; sem script novo: causa 'falta deploy'", () => {
  const t = setup();
  const lines = [
    "#!/bin/sh",
    'case "$6" in',
    "  *print-access-scopes*) echo '[print-access-scopes] 15 scope(s) concedido(s) em x.myshopify.com:'; echo '[print-access-scopes] read_themes: concedido'; exit 0;;",
    '  *theme-contract-status*) printf \'{\\n  "ok": true,\\n  "enforced": true,\\n  "contract": {\\n    "status": "ok",\\n    "blocking": [],\\n    "themeName": "Segredo"\\n  }\\n}\\n\'; exit 0;;',
    "esac",
  ];
  fs.writeFileSync(t.bin, lines.join("\n") + "\n", { mode: 0o755 });
  const r = spawnSync("bash", [SCRIPT, "diagnose_theme", "dry-run"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, FLYCTL: t.bin, FAKE_LOG: t.log, FAKE_COUNT: t.count, GITHUB_STEP_SUMMARY: t.summary } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /enforced = true, status = ok/);
  assert.doesNotMatch(r.stdout + fs.readFileSync(t.summary, "utf8"), /Segredo|"contract"/);
  const bad = run("diagnose_characters", "dry-run", { FAKE_RC: "1" });
  assert.equal(bad.status, 1);
});

console.log("tarefas novas (só leitura) e db_push com a flag DB_DEGRADED");
// Cópia de dev.sqlite íntegra, criada com Prisma, para o restauro em dry-run (sem rede).
function healthyDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maint-db-")), "dev.sqlite");
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { PrismaClient } from "@prisma/client"; const p = new PrismaClient(); await p.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS probe (x INTEGER)"); await p.$disconnect();`],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: `file:${file}` }, timeout: 120000 }
  );
  assert.equal(r.status, 0, r.stderr);
  return file;
}
function garbageDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maint-bad-")), "dev.sqlite");
  fs.writeFileSync(file, "lixo ".repeat(300));
  return file;
}
check("db_push recusa com a flag presente, em dry-run e em execute: sem db:push nem migrate diff", () => {
  for (const phase of ["dry-run", "execute"]) {
    const r = run("db_push", phase, { FAKE_FLAG: "present" });
    assert.equal(r.status, 1, phase);
    assert.ok(!ran(r, "db:push") && !ran(r, "migrate diff"), phase);
    assert.match(r.summaryText, /db:push recusado: flag DB_DEGRADED presente/, phase);
  }
});
check("db_push com a flag ilegível: recusa com código 2, sem db:push", () => {
  const r = run("db_push", "execute", { FAKE_FLAG: "unknown" });
  assert.equal(r.status, 2);
  assert.ok(!ran(r, "db:push"));
});
check("db_push com a flag ausente: segue como antes", () => {
  const r = run("db_push", "execute", { FAKE_FLAG: "absent" });
  assert.equal(r.status, 0);
  assert.ok(ran(r, "npm run db:push"));
});
check("db_flag_check: ausente → 0; presente → 1; ilegível → 2; o resumo não mostra causa", () => {
  let r = run("db_flag_check", "dry-run", { FAKE_FLAG: "absent" });
  assert.equal(r.status, 0);
  assert.match(r.summaryText, /Flag DB_DEGRADED: \*\*ausente\*\*/);
  r = run("db_flag_check", "dry-run", { FAKE_FLAG: "present" });
  assert.equal(r.status, 1);
  assert.match(r.summaryText, /Flag DB_DEGRADED presente/);
  r = run("db_flag_check", "dry-run", { FAKE_FLAG: "unknown" });
  assert.equal(r.status, 2);
});
check("logs_recent: sem erros → 0 com contagens; com DbDegradedError → 1 e para a sequência", () => {
  let r = run("logs_recent", "dry-run", { FAKE_LOGS: "app ok\napp ok" });
  assert.equal(r.status, 0);
  assert.match(r.summaryText, /DbDegradedError: \*\*0\*\*/);
  assert.ok(ran(r, "logs -a alterpop-importer-app --no-tail --json"), "flyctl logs com --json, sem flags inventadas");
  assert.doesNotMatch(r.summaryText, /app ok/, "o texto das linhas nunca sai no resumo");
  r = run("logs_recent", "dry-run", { FAKE_LOGS: "[prisma] x: DbDegradedError: BD em modo degradado\napp: Modo degradado ativo" });
  assert.equal(r.status, 1);
  assert.match(r.summaryText, /DbDegradedError: \*\*1\*\*/);
  assert.ok(!ran(r, "db:push"));
});
check("logs_recent: marcas de indexação, reinício e recusa → 0 com aviso; causa e duração do último fim", () => {
  const linhas = [
    '{"timestamp":"2026-10-14T20:00:00Z","message":"[indexacao] inicio causa=ciclo modo=completa"}',
    '{"timestamp":"2026-10-14T20:30:00Z","message":"[indexacao] worker terminou sem concluir (code=null signal=SIGKILL)"}',
    '{"timestamp":"2026-10-14T20:31:00Z","message":"[indexacao] fim causa=ciclo estado=falhou duracao_s=1860"}',
    '{"timestamp":"2026-10-14T21:00:00Z","message":"[indexacao] inicio causa=painel modo=retoma"}',
    '{"timestamp":"2026-10-14T21:05:00Z","message":"[dbDegraded] recusado: escrita na fila de curadoria"}',
    '{"timestamp":"2026-10-14T21:40:00Z","message":"[indexacao] fim causa=painel estado=concluida duracao_s=2400 indexados=25000"}',
  ].join("\\n");
  const r = run("logs_recent", "dry-run", { FAKE_LOGS: linhas });
  assert.equal(r.status, 0, "sinais de reinício e recusa são aviso, não vermelho");
  assert.match(r.summaryText, /Resultado:\*\* ⚠️ Sinais nos logs/);
  assert.match(r.summaryText, /Reinícios do worker \(saiu sem concluir\): \*\*1\*\*/);
  assert.match(r.summaryText, /Escritas recusadas: \*\*1\*\*, das quais na fila de curadoria: \*\*1\*\*/);
  assert.match(r.summaryText, /Indexação: \*\*2\*\* início\(s\), por causa: painel 1, ciclo 1/);
  assert.match(r.summaryText, /Último fim de indexação: causa \*\*painel\*\*, estado \*\*concluida\*\*, duração \*\*2400\*\* s/);
  assert.doesNotMatch(r.summaryText, /25000|escrita na fila/, "nem contagens internas nem texto de linha");
});
check("restore_dry_run: cópia íntegra → integrity ok e código 0; sem flag apagada; sem --execute", () => {
  const r = run("restore_dry_run", "dry-run", { FAKE_DB: healthyDb() });
  assert.equal(r.status, 0, r.summaryText);
  assert.match(r.summaryText, /integrity_check da cópia: \*\*ok\*\*/);
  assert.ok(ran(r, "sftp get /app/data/dev.sqlite"));
  assert.ok(!ran(r, "--execute") && !ran(r, "db:push"));
});
check("restore_dry_run: cópia corrompida → código 1 com causa; a BD da Fly não é tocada", () => {
  const r = run("restore_dry_run", "dry-run", { FAKE_DB: garbageDb() });
  assert.equal(r.status, 1);
  assert.match(r.summaryText, /não passa integrity_check/);
  assert.ok(!ran(r, "npm run db:push") && !ran(r, "--execute"));
});
check("restore_dry_run: falha ao copiar → código 1 com causa de cópia, sem restauro", () => {
  const r = run("restore_dry_run", "dry-run");
  assert.equal(r.status, 1);
  assert.match(r.summaryText, /não consegui copiar dev\.sqlite/);
  assert.ok(!ran(r, "restore-db-degraded"));
});
check("DBG-37: WAL ausente no volume → 'sem WAL', integrity ok, código 0", () => {
  const r = run("restore_dry_run", "dry-run", { FAKE_DB: healthyDb(), FAKE_WAL: "absent" });
  assert.equal(r.status, 0, r.summaryText);
  assert.match(r.summaryText, /WAL: \*\*sem WAL no volume\*\*/);
  assert.match(r.summaryText, /integrity_check da cópia: \*\*ok\*\*/);
  assert.ok(!ran(r, "sftp get /app/data/dev.sqlite-wal"), "o WAL só se pede quando existe");
});
check("DBG-37: WAL presente e copiado → código 0, 'copiado', integrity ok", () => {
  const r = run("restore_dry_run", "dry-run", { FAKE_DB: healthyDb(), FAKE_WAL: "present" });
  assert.equal(r.status, 0, r.summaryText);
  assert.match(r.summaryText, /WAL: \*\*copiado\*\*/);
  assert.match(r.summaryText, /integrity_check da cópia: \*\*ok\*\*/);
  assert.ok(ran(r, "sftp get /app/data/dev.sqlite-wal"));
});
check("DBG-37: WAL presente e cópia do WAL falha → código 1 com causa de WAL, sem integrity ok", () => {
  const r = run("restore_dry_run", "dry-run", { FAKE_DB: healthyDb(), FAKE_WAL: "present", FAKE_WAL_FAIL: "1" });
  assert.equal(r.status, 1, r.summaryText);
  assert.match(r.summaryText, /o WAL existe no volume e não consegui copiá-lo/);
  assert.match(r.summaryText, /WAL: \*\*existe, cópia falhou\*\*/);
  assert.match(r.summaryText, /integrity_check da cópia: \*\*não correu\*\*/);
  assert.doesNotMatch(r.summaryText, /integrity_check da cópia: \*\*ok\*\*/);
});
check("DBG-37: estado do WAL ilegível → código 2, sem restauro sobre a cópia", () => {
  const r = run("restore_dry_run", "dry-run", { FAKE_DB: healthyDb(), FAKE_WAL: "unknown" });
  assert.equal(r.status, 2, r.summaryText);
  assert.match(r.summaryText, /não consegui ler se o WAL existe/);
  assert.match(r.summaryText, /integrity_check da cópia: \*\*não correu\*\*/);
});
check("tarefas novas recusam execute com código 64, sem tocar na Fly", () => {
  for (const task of SO_LEITURA_NOVA) {
    const r = run(task, "execute");
    assert.equal(r.status, 64, task);
    assert.equal(r.calls.length, 0, task);
  }
});
check("workflow: as tarefas novas não entram no job de escrita (execute)", () => {
  const job = code.slice(code.indexOf("  execute:"));
  for (const task of SO_LEITURA_NOVA) assert.doesNotMatch(job, new RegExp(task));
});
check("workflow: o restauro de cópia prepara dependências só nessa tarefa", () => {
  const job = code.slice(code.indexOf("  dry-run:"), code.indexOf("  execute:"));
  assert.match(job, /if: inputs\.task == 'restore_dry_run'[\s\S]*npm ci/);
});

console.log("resumo");
check("resumo em português com tarefa, modo, resultado, o que faz e saída", () => {
  const r = run("tags_cleanup", "dry-run");
  for (const frag of ["## Manutenção · `tags_cleanup` · dry-run (não escreve)", "**Resultado:** ✅ Concluída sem erros", "**O que faz:**", "Não escreve na loja", "Este resumo só tem contagens e estados"]) {
    assert.ok(r.summaryText.includes(frag), frag);
  }
  assert.match(r.summaryText, /Produtos lidos: \*\*57\*\*/);
  assert.match(r.summaryText, /new-arrival: 57; Funko: 40/);
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
  assert.match(fs.readFileSync(out, "utf8"), /key=lidos 57, a limpar 57,179/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nmaintenance: todos os casos passaram");
