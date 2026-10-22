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
    /task:\n\s+description: .*\n\s+type: choice\n\s+required: true\n\s+options:\n\s+- catalog_health\n\s+- diagnose_theme\n\s+- diagnose_characters\n\s+- price_check\n\s+- volume_snapshot\n\s+- tags_cleanup\n\s+- character_pages_sync\n\s+- db_push\n\s+- reset_dry_run\n\s+- reset_execute\n\s+- db_flag_check\n\s+- logs_recent\n\s+- restore_dry_run\n\s+- active_vs_queue\n\s+- elite_purge_dry_run\n\s+- indexing_status\n\s+- machine_status\n\s+- image_check\n\s+- scale_memory\n\s+mode:/
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
  assert.match(job, /\["volume_snapshot","tags_cleanup","character_pages_sync","db_push","scale_memory"]/);
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
  *RESET_MODO=*)
    printf '%b' "$FAKE_RESET"; exit "\${FAKE_RESET_RC:-0}";;
  *base64*)
    b=$(echo "$cmd" | cut -d' ' -f7)
    if echo "$b" | base64 -d 2>/dev/null | grep -q "escrita:"; then
      printf 'ERRO: escrita: metaobjectUpsert(…): Products cannot be blank\\n'; exit 0
    fi
    if echo "$b" | base64 -d 2>/dev/null | grep -q "IC_AMOSTRA"; then printf '%b' "$FAKE_IC"; exit "\${FAKE_IC_RC:-0}"; fi
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
function run(task, phase, env = {}, script = SCRIPT) {
  const t = setup();
  const r = spawnSync("bash", [script, task, phase], {
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
      GATE_REPEAT_SECONDS: "0",
      WAIT_MAX_ATTEMPTS: "3",
      ...env,
    },
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  return { ...r, calls: read(t.log).split("\n").filter(Boolean), summaryText: read(t.summary), probes: Number(read(t.count) || 0) };
}
const ran = (r, needle) => r.calls.some((c) => c.includes(needle));
const SO_LEITURA_NOVA = ["db_flag_check", "logs_recent", "restore_dry_run", "image_check", "reset_dry_run"];

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
// Saída de contagens do image_check, sintética: o flyctl falso devolve-a no lugar da Fly.
const IC_SINTETICO = [
  "IC: total=26 vazio=3 https=13 http=8 invalido=2 multi=3",
  "IC_HOST: pos=1 host=cdn-sintetico.example n=17",
  "IC_HOST: pos=2 host=[::1]:443 n=4",
  "IC_AMOSTRA: pedidas=20 obtidas=20 https=10 http=10",
  "IC_HTTPS: testadas=10 ok=9 com_erro=1",
  "IC_TOTAIS: ok_sem_referer=18 ok_referer_app=18 para_https=0 para_http=0 com_erro=0",
  "IC_RESULTADO: n=12 esquema=https sem_referer=200/imagem app=200/imagem redireciona=nao destino=-",
  "IC_RESULTADO: n=8 esquema=http sem_referer=200/imagem app=200/imagem redireciona=nao destino=-",
  "",
].join("\n");
// Saídas sintéticas do driver do reset: o flyctl falso as devolve no lugar da Fly. Só RS e RS_RESULTADO, com contagens.
const OK_SINTETICO = "0123456789ab";
const RESET_BASE = [
  "RS: produtos_na_loja=3 itens_publicados=1 impressao=0123456789ab",
  "RS_ESTADO: estado=APPROVED n=1",
  "RS_ESTADO: estado=PENDING n=2",
  "RS_ESTADO: estado=PUBLISHED n=0",
  "RS_ESTADO: estado=REJECTED n=0",
  "RS_ESTADO: estado=SYNC_ERROR n=0",
  "RS_D2: decisoes_humanas_mantidas=0",
  "RS_GUARDAS: indexacao=livre reserva=livre trinco=livre db_degradado=nao",
  "",
].join("\n");
// RS_TRAVA e RS_REPARO saem nos dois modos (contrato do driver). Por omissão: loja e fila batem, nada reparado.
const trava = (igual = "sim", comEntrada = 3, total = 3) => `RS_TRAVA: total_na_loja=${total} com_entrada_na_fila=${comEntrada} igual=${igual}\n`;
const reparo = (reparada = "nao", token = "nao") => `RS_REPARO: fila_reparada=${reparada} token_renovado=${token}\n`;
const RESET_DRY = RESET_BASE + trava() + reparo();
const RESET_EXEC = RESET_DRY + "RS_RESULTADO: modo=execute apagados=3 revertidos=1 falhados=0 produtos_restantes=0 published_restantes=0\n";
const envDe = (task, phase) =>
  task === "image_check"
    ? { FAKE_IC: IC_SINTETICO }
    : task.startsWith("reset_")
      ? { RESET_OK: OK_SINTETICO, FAKE_RESET: phase === "execute" ? RESET_EXEC : RESET_DRY }
      : {};
check("nenhuma tarefa/fase deixa SKU, handle, preço, GID ou JSON completo no log nem no resumo", () => {
  for (const task of ["catalog_health", "diagnose_theme", "diagnose_characters", "price_check", "volume_snapshot", "tags_cleanup", "character_pages_sync", "db_push", "db_flag_check", "logs_recent", "restore_dry_run", "image_check", "reset_dry_run", "reset_execute"]) {
    for (const phase of SO_LEITURA_NOVA.includes(task) ? ["dry-run"] : ["dry-run", "execute"]) {
      const r = run(task, phase, envDe(task, phase));
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
check("logs_recent: lotes de fila → linha com o lote mais lento e a contagem", () => {
  const linhas = [
    '{"timestamp":"2026-10-14T20:00:00Z","message":"[indexacao] lote-fila duracao_ms=120 itens=250"}',
    '{"timestamp":"2026-10-14T20:00:05Z","message":"[indexacao] lote-fila duracao_ms=1534 itens=250"}',
    '{"timestamp":"2026-10-14T20:00:09Z","message":"[indexacao] lote-fila duracao_ms=410 itens=40"}',
  ].join("\\n");
  const r = run("logs_recent", "dry-run", { FAKE_LOGS: linhas });
  assert.equal(r.status, 0);
  assert.match(r.summaryText, /Lote de fila mais lento: \*\*1534\*\* ms, em \*\*3\*\* lotes\./);
});
check("logs_recent: sem lotes de fila → a linha existe, com '-' e 0, sem erro", () => {
  const r = run("logs_recent", "dry-run", { FAKE_LOGS: "app ok" });
  assert.equal(r.status, 0);
  assert.match(r.summaryText, /Lote de fila mais lento: \*\*-\*\* ms, em \*\*0\*\* lotes\./);
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
check("image_check: nas opções do workflow, fora do job execute e fora de WRITES do sh", () => {
  assert.match(code, /^\s+- image_check$/m);
  const job = code.slice(code.indexOf("  execute:"));
  assert.doesNotMatch(job, /image_check/);
  const writes = sh.match(/^case "\$TASK" in (.*?)\) WRITES=true/m);
  assert.ok(writes, "linha WRITES do maintenance.sh");
  assert.doesNotMatch(writes[1], /image_check/);
});
check("workflow: o restauro de cópia prepara dependências só nessa tarefa", () => {
  const job = code.slice(code.indexOf("  dry-run:"), code.indexOf("  execute:"));
  assert.match(job, /if: inputs\.task == 'restore_dry_run'[\s\S]*npm ci/);
});

console.log("reset Shopify: reset_dry_run e reset_execute (flyctl falso; o driver real vai por base64 para a Fly)");
check("reset_dry_run: só o driver em RESET_MODO=dry; resumo com contagens e a impressão digital", () => {
  const r = run("reset_dry_run", "dry-run", { FAKE_RESET: RESET_DRY });
  assert.equal(r.status, 0, r.summaryText);
  assert.ok(ran(r, "RESET_MODO=dry node --input-type=module -"), "o driver corre em dry");
  assert.ok(!ran(r, "RESET_MODO=execute"), "nenhuma chamada de execute");
  assert.match(r.summaryText, /Produtos na loja: \*\*3\*\*\. Itens publicados na fila: \*\*1\*\*\./);
  assert.match(r.summaryText, /Impressão digital da lista a apagar: \*\*0123456789ab\*\*/);
  assert.match(r.summaryText, /Decisões humanas mantidas \(D2\): \*\*0\*\*/);
  assert.match(r.summaryText, /Guardas: indexação \*\*livre\*\*, reserva \*\*livre\*\*, trinco \*\*livre\*\*, BD degradada \*\*nao\*\*/);
  assert.match(r.summaryText, /só leitura/);
});
check("reset_dry_run: execute recusa com código 64, sem tocar na Fly", () => {
  const r = run("reset_dry_run", "execute", { FAKE_RESET: RESET_DRY });
  assert.equal(r.status, 64);
  assert.equal(r.calls.length, 0);
});
check("reset_dry_run: exit 0 sem linhas RS é falha (código 2), não verde", () => {
  const r = run("reset_dry_run", "dry-run", { FAKE_RESET: "" });
  assert.equal(r.status, 2);
  assert.match(r.summaryText, /o driver do reset não devolveu as contagens/);
});
check("reset_dry_run: a classe do driver vira causa, sem texto do erro", () => {
  const r = run("reset_dry_run", "dry-run", { FAKE_RESET: "RS_ERRO: classe=leitura_falhou\n", FAKE_RESET_RC: "2" });
  assert.equal(r.status, 2);
  assert.match(r.summaryText, /não consegui ler a loja ou a fila/);
});
check("reset_execute: sem ok válido (vazio, curto, maiúsculas, texto), código 64 e nada chamado, nas duas fases", () => {
  for (const ok of [undefined, "", "ABC", "0123456789abc", "0123456789AB", "x; ls"]) {
    for (const phase of ["dry-run", "execute"]) {
      const env = { FAKE_RESET: RESET_EXEC };
      if (ok !== undefined) env.RESET_OK = ok;
      const r = run("reset_execute", phase, env);
      assert.equal(r.status, 64, `${JSON.stringify(ok)} ${phase}`);
      assert.equal(r.calls.length, 0, `${JSON.stringify(ok)} ${phase}: nada chamado`);
    }
  }
});
check("reset_execute, dry-run (job 1): ok igual à impressão → código 0, sem RESET_MODO=execute", () => {
  const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_DRY });
  assert.equal(r.status, 0, r.summaryText);
  assert.ok(ran(r, "RESET_MODO=dry node"), "só o dry-run");
  assert.ok(!ran(r, "RESET_MODO=execute"), "nada apagado no job 1");
  assert.match(r.summaryText, /Impressão digital igual à aprovada \(ok\): \*\*sim\*\*/);
  assert.match(r.summaryText, /pode aprovar o execute/);
});
check("reset_execute, dry-run (job 1): ok diferente → código 3, sem RESET_MODO=execute", () => {
  const r = run("reset_execute", "dry-run", { RESET_OK: "fedcba987654", FAKE_RESET: RESET_DRY });
  assert.equal(r.status, 3);
  assert.ok(!ran(r, "RESET_MODO=execute"));
  assert.match(r.summaryText, /a impressão digital da loja não é a aprovada: nada foi apagado/);
  assert.match(r.summaryText, /Impressão digital igual à aprovada \(ok\): \*\*não\*\*/);
});
check("reset_execute, execute: ok certo → RESET_MODO=execute com RESET_OK, resultado com contagens", () => {
  const r = run("reset_execute", "execute", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_EXEC });
  assert.equal(r.status, 0, r.summaryText);
  assert.ok(ran(r, `RESET_MODO=execute RESET_OK=${OK_SINTETICO} node --input-type=module -`), "o reset real com o ok");
  assert.match(r.summaryText, /Apagados \*\*3\*\*, revertidos \*\*1\*\*, falhados \*\*0\*\*/);
  assert.match(r.summaryText, /produtos restantes na loja \*\*0\*\*, PUBLISHED restantes na fila \*\*0\*\*/);
  assert.match(r.summaryText, /execute \(escreve\)/);
});
check("reset_execute, execute: o driver recusa (3) ou falha a meio (1), com a causa e as contagens que saíram", () => {
  let r = run("reset_execute", "execute", { RESET_OK: OK_SINTETICO, FAKE_RESET: "RS_ERRO: classe=impressao_diferente\n", FAKE_RESET_RC: "3" });
  assert.equal(r.status, 3);
  assert.match(r.summaryText, /a impressão digital da loja não é a aprovada/);
  const parcial = RESET_DRY + "RS_RESULTADO: modo=execute apagados=2 revertidos=0 falhados=1 produtos_restantes=1 published_restantes=1\nRS_ERRO: classe=motor_falhou\n";
  r = run("reset_execute", "execute", { RESET_OK: OK_SINTETICO, FAKE_RESET: parcial, FAKE_RESET_RC: "1" });
  assert.equal(r.status, 1);
  assert.match(r.summaryText, /Apagados \*\*2\*\*, revertidos \*\*0\*\*, falhados \*\*1\*\*/);
  assert.match(r.summaryText, /o reset falhou ou não ficou concluído/);
});
check("reset_execute, execute: exit 0 sem RS_RESULTADO não é verde", () => {
  const r = run("reset_execute", "execute", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_DRY });
  assert.equal(r.status, 2);
  assert.match(r.summaryText, /o reset não devolveu o resultado/);
});
check("reset: nenhum SKU, GID, título, URL nem linha crua sai no stdout, no stderr nem no resumo", () => {
  const cru = "erro cru: gid://shopify/Product/SINTETICO-9 SKU-SINTETICO-9 https://loja-sintetica.example/a?v=1\n";
  for (const [task, phase, env] of [
    ["reset_dry_run", "dry-run", { FAKE_RESET: RESET_DRY + cru }],
    ["reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_DRY + cru }],
    ["reset_execute", "execute", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_EXEC + cru }],
  ]) {
    const r = run(task, phase, env);
    const visivel = `${r.stdout}\n${r.stderr}\n${r.summaryText}`;
    for (const rx of [...PROIBIDO, /SINTETICO/, /loja-sintetica/, /:\/\//]) assert.doesNotMatch(visivel, rx, `${task}/${phase} expõe ${rx}`);
  }
});

/** Uma cópia do maintenance.sh com uma troca de texto (mutação), numa raiz própria, com o driver ao lado. */
function trocaUmaSh(texto, nome, antigo, novo) {
  const ancora = typeof antigo === "function" ? antigo(texto) : antigo; // âncora calculada a partir do próprio texto
  const vezes = texto.split(ancora).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  return texto.replace(ancora, () => novo);
}
/** A linha inteira (com o fim de linha) que contém o trecho, única no texto. Para mutar uma linha sem a copiar. */
function linhaDe(texto, trecho) {
  const linhas = texto.split("\n").filter((l) => l.includes(trecho));
  if (linhas.length !== 1) throw new Error(`linha com "${trecho}": existem ${linhas.length}`);
  return linhas[0] + "\n";
}
function scriptMutado(nome, antigo, novo) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "maint-mut-"));
  fs.mkdirSync(path.join(raiz, "scripts/ci"), { recursive: true });
  fs.mkdirSync(path.join(raiz, "scripts/maintenance"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "scripts/ci/maintenance.sh"), trocaUmaSh(sh, nome, antigo, novo));
  fs.copyFileSync(path.join(ROOT, "scripts/maintenance/reset-maintenance.mjs"), path.join(raiz, "scripts/maintenance/reset-maintenance.mjs"));
  return path.join(raiz, "scripts/ci/maintenance.sh");
}
/** Mutação do wrapper: o caso, com o wrapper mutado, tem de falhar. */
function mutanteSh(nome, antigo, novo, caso) {
  check(`mutação ${nome}`, () => {
    let apanhou = false;
    try {
      caso(scriptMutado(nome, antigo, novo));
    } catch {
      apanhou = true;
    }
    if (!apanhou) throw new Error(`mutação ${nome}: o caso não a apanhou`);
  });
}
mutanteSh("reset-impressao-sem-conferir", 'if [ "$IMP_LIDA" != "$RESET_OK" ]; then', "if false; then", (script) => {
  const r = run("reset_execute", "dry-run", { RESET_OK: "fedcba987654", FAKE_RESET: RESET_DRY }, script);
  assert.equal(r.status, 3, `impressão diferente no job 1 sai com 3, saiu ${r.status}`);
});
mutanteSh("reset-dry-chama-execute", 'if [ "$1" = "execute" ]; then', 'if [ "$1" = "dry" ]; then', (script) => {
  const r = run("reset_dry_run", "dry-run", { FAKE_RESET: RESET_DRY }, script);
  assert.equal(r.status, 0, `o dry-run sai com 0, saiu ${r.status}: ${r.stderr}`);
  assert.ok(ran(r, "RESET_MODO=dry node"), "o dry-run chama o driver em dry");
  assert.ok(!ran(r, "RESET_MODO=execute"), "o dry-run não chama execute");
});
mutanteSh("reset-sem-validar-ok", 'if ! [[ "${RESET_OK:-}" =~ ^[0-9a-f]{12}$ ]]; then', "if false; then", (script) => {
  const r = run("reset_execute", "execute", { RESET_OK: "x; ls", FAKE_RESET: RESET_EXEC }, script);
  assert.equal(r.status, 64, `ok mal formado sai com 64, saiu ${r.status}`);
});
mutanteSh(
  "reset-dry-run-aceita-execute",
  '    if [ "$PHASE" = "execute" ]; then echo "O reset_dry_run só lê',
  '    if false; then echo "O reset_dry_run só lê',
  (script) => {
    const r = run("reset_dry_run", "execute", { FAKE_RESET: RESET_DRY }, script);
    assert.equal(r.status, 64, `reset_dry_run com execute sai com 64, saiu ${r.status}`);
  },
);

// S1 a S4: a trava loja/fila, a fila reparada e a indexação entre processos no resumo e nos códigos de saída.
check("S1 reset_dry_run: imprime 'Loja: total na loja' e 'Fila reparada' com os valores das linhas, e sai com 0 mesmo com igual=nao", () => {
  const r = run("reset_dry_run", "dry-run", { FAKE_RESET: RESET_BASE + trava("nao", 2, 3) + reparo("sim", "nao") });
  assert.equal(r.status, 0, r.summaryText);
  assert.match(r.summaryText, /- Loja: total na loja \*\*3\*\*; com entrada na fila \*\*2\*\*; iguais: \*\*não\*\*\./);
  assert.match(r.summaryText, /- Fila reparada: \*\*sim\*\*\. Token renovado: \*\*não\*\*\./);
  assert.match(r.summaryText, /um sim também pode vir de uma escrita da app durante a leitura/i);
});
mutanteSh("reset-sem-bullet-loja", (t) => linhaDe(t, "- Loja: total na loja"), "", (script) => {
  const r = run("reset_dry_run", "dry-run", { FAKE_RESET: RESET_DRY }, script);
  assert.match(r.summaryText, /Loja: total na loja/, "sem a bullet da loja, o resumo não a tem");
});
check("S2 reset_execute, dry-run (job 1): RS_TRAVA igual=nao → código 3, causa de trava e nada em execute; sem a linha da trava → código 2", () => {
  const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_BASE + trava("nao", 2, 3) + reparo() });
  assert.equal(r.status, 3, r.summaryText);
  assert.ok(!ran(r, "RESET_MODO=execute"), "nada apagado no job 1");
  assert.match(r.summaryText, /a loja e a fila não batem: nada foi apagado\. Rever antes do execute\./);
  assert.doesNotMatch(r.summaryText, /pode aprovar o execute/);
  const sem = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_BASE + reparo() });
  assert.equal(sem.status, 2, sem.summaryText);
  assert.ok(!ran(sem, "RESET_MODO=execute"), "sem a trava, também nada em execute");
  assert.match(sem.summaryText, /não comparei nada/);
});
mutanteSh("reset-job1-sem-trava", "RC=3; causa_reset trava_loja_fila", "RC=0", (script) => {
  const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_BASE + trava("nao", 2, 3) + reparo() }, script);
  assert.equal(r.status, 3, `loja e fila diferentes no job 1 saem com 3, saiu ${r.status}`);
  assert.ok(!ran(r, "RESET_MODO=execute"), "o job 1 não chama execute");
});
check("S3 reset_execute, dry-run (job 1) e reset_dry_run: classe indexacao_em_curso → código 3 e causa de indexação, mesmo com outro código do driver", () => {
  for (const rc of ["3", "1"]) {
    const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: "RS_ERRO: classe=indexacao_em_curso\n", FAKE_RESET_RC: rc });
    assert.equal(r.status, 3, `job 1, driver ${rc}: ${r.summaryText}`);
    assert.ok(!ran(r, "RESET_MODO=execute"), "nada apagado no job 1");
    assert.match(r.summaryText, /há uma indexação em curso: nada foi apagado\. Repetir depois\./);
  }
  const d = run("reset_dry_run", "dry-run", { FAKE_RESET: "RS_ERRO: classe=indexacao_em_curso\n", FAKE_RESET_RC: "3" });
  assert.equal(d.status, 3, d.summaryText);
  assert.match(d.summaryText, /há uma indexação em curso/);
});
mutanteSh("reset-sem-causa-indexacao", (t) => linhaDe(t, "indexacao_em_curso) CAUSE="), "", (script) => {
  const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: "RS_ERRO: classe=indexacao_em_curso\n", FAKE_RESET_RC: "3" }, script);
  assert.match(r.summaryText, /há uma indexação em curso: nada foi apagado/, "sem a causa, a classe cai no texto genérico");
});
mutanteSh("reset-job1-sem-rc-indexacao", (t) => linhaDe(t, '"$CLASSE_DRIVER" = "indexacao_em_curso"'), "", (script) => {
  const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: "RS_ERRO: classe=indexacao_em_curso\n", FAKE_RESET_RC: "1" }, script);
  assert.equal(r.status, 3, `o job 1 sai com 3 com indexação, saiu ${r.status}`);
});
check("S4 reset_execute, execute: ok certo e saída limpa chamam o driver em execute; o código 3 do driver (trava) é recusa, não sucesso", () => {
  const ok = run("reset_execute", "execute", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_EXEC });
  assert.equal(ok.status, 0, ok.summaryText);
  assert.ok(ran(ok, `RESET_MODO=execute RESET_OK=${OK_SINTETICO} node --input-type=module -`), "o reset real com o ok");
  const recusa = run("reset_execute", "execute", {
    RESET_OK: OK_SINTETICO,
    FAKE_RESET: RESET_BASE + trava("nao", 2, 3) + reparo() + "RS_ERRO: classe=trava_loja_fila\n",
    FAKE_RESET_RC: "3",
  });
  assert.equal(recusa.status, 3, recusa.summaryText);
  assert.ok(ran(recusa, "RESET_MODO=execute"), "o execute chamou o driver, que recusou");
  assert.match(recusa.summaryText, /a loja e a fila não batem: nada foi apagado\. Rever antes do execute\./);
  assert.doesNotMatch(recusa.summaryText, /Apagados \*\*/);
});
mutanteSh("reset-execute-codigo3-sucesso", 'reset_driver execute "$RESET_OK"; RC=$?', 'reset_driver execute "$RESET_OK"; RC=$?; if [ "$RC" -eq 3 ]; then RC=0; fi', (script) => {
  const r = run("reset_execute", "execute", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_BASE + trava("nao", 2, 3) + reparo() + "RS_ERRO: classe=trava_loja_fila\n", FAKE_RESET_RC: "3" }, script);
  assert.equal(r.status, 3, `o código 3 do driver não é sucesso, saiu ${r.status}`);
});

// S5 a S7: o job 1 não aprova com as guardas fechadas nem com uma linha RS incompleta; uma falha de ligação diz que o reset pode ter começado.
check("S5 reset_execute, dry-run (job 1): guardas fechadas → código 4 e sem 'pode aprovar o execute'; sem a linha das guardas → código 2", () => {
  const fechadas = [
    "RS_GUARDAS: indexacao=livre reserva=ocupada trinco=livre db_degradado=nao",
    "RS_GUARDAS: indexacao=ocupada reserva=livre trinco=livre db_degradado=nao",
    "RS_GUARDAS: indexacao=livre reserva=livre trinco=livre db_degradado=sim",
  ];
  for (const guardas of fechadas) {
    const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_DRY.replace(/^RS_GUARDAS: .*$/m, guardas) });
    assert.equal(r.status, 4, `${guardas}: sai com 4, saiu ${r.status}: ${r.summaryText}`);
    assert.doesNotMatch(r.summaryText, /pode aprovar o execute/, guardas);
    assert.match(r.summaryText, /Guardas ocupadas: não aprovar o execute agora/, guardas);
    assert.ok(!ran(r, "RESET_MODO=execute"), "nada apagado no job 1");
  }
  const sem = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_DRY.replace(/^RS_GUARDAS: .*\n/m, "") });
  assert.equal(sem.status, 2, sem.summaryText);
  assert.doesNotMatch(sem.summaryText, /pode aprovar o execute/);
});
mutanteSh("reset-job1-guardas-fechadas-passam", 'elif echo "$GUARDAS_LIDAS" | grep -qE \'indexacao=ocupada|reserva=ocupada|db_degradado=sim\'; then', "elif false; then", (script) => {
  const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_DRY.replace(/^RS_GUARDAS: .*$/m, "RS_GUARDAS: indexacao=livre reserva=ocupada trinco=livre db_degradado=nao") }, script);
  assert.equal(r.status, 4, `guardas fechadas no job 1 saem com 4, saiu ${r.status}`);
});
mutanteSh("reset-job1-sem-guardas-aprova", 'elif [ -z "$GUARDAS_LIDAS" ]; then', "elif false; then", (script) => {
  const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_DRY.replace(/^RS_GUARDAS: .*\n/m, "") }, script);
  assert.equal(r.status, 2, `sem as guardas o job 1 sai com 2, saiu ${r.status}`);
});
check("S6 reset_execute, dry-run (job 1): linha RS sem impressão digital → código 2 e causa de leitura, não 'não é a aprovada'", () => {
  const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_DRY.replace(" impressao=0123456789ab", "") });
  assert.equal(r.status, 2, r.summaryText);
  assert.match(r.summaryText, /não devolveu a impressão digital da loja/);
  assert.doesNotMatch(r.summaryText, /não é a aprovada/);
  assert.ok(!ran(r, "RESET_MODO=execute"), "nada apagado no job 1");
});
mutanteSh("reset-job1-linha-sem-impressao-e-3", 'if [ -z "$IMP_LIDA" ]; then', "if false; then", (script) => {
  const r = run("reset_execute", "dry-run", { RESET_OK: OK_SINTETICO, FAKE_RESET: RESET_DRY.replace(" impressao=0123456789ab", "") }, script);
  assert.equal(r.status, 2, `linha RS sem impressão no job 1 sai com 2, saiu ${r.status}`);
});
check("S7 reset_execute, execute: falha de ligação sem classe do driver → código do ssh, e a causa diz que o reset pode já ter começado", () => {
  const r = run("reset_execute", "execute", { RESET_OK: OK_SINTETICO, FAKE_RESET: "ssh: falhou\n", FAKE_RESET_RC: "255" });
  assert.equal(r.status, 255, r.summaryText);
  assert.match(r.summaryText, /ligação ou saída inesperada/);
  assert.match(r.summaryText, /Se o reset já tinha começado/);
});
mutanteSh(
  "reset-sem-causa-de-ligacao",
  (t) => linhaDe(t, "devolveu uma classe conhecida"),
  '    *) CAUSE="o driver do reset não devolveu uma classe conhecida." ;;\n',
  (script) => {
    const r = run("reset_execute", "execute", { RESET_OK: OK_SINTETICO, FAKE_RESET: "ssh: falhou\n", FAKE_RESET_RC: "255" }, script);
    assert.match(r.summaryText, /ligação ou saída inesperada/, "a causa antiga não diz que o reset pode ter começado");
  },
);

/** Porta do execute de reset: needs, environment production, mode=execute, reset_execute na lista e reset_dry_run fora. */
function portaDoExecute(texto) {
  const job = texto.slice(texto.indexOf("  execute:"));
  const tarefas = JSON.parse((job.match(/contains\(fromJSON\('(\[[^\]]*\])'\), inputs\.task\)/) || [])[1] || "[]");
  return (
    /needs: dry-run/.test(job) &&
    /environment: production/.test(job) &&
    /inputs\.mode == 'execute'/.test(job) &&
    /\|\| inputs\.task == 'reset_execute'\)/.test(job) &&
    !tarefas.includes("reset_dry_run") &&
    !/reset_dry_run/.test(job)
  );
}
check("reset: o execute só corre com environment production, mode=execute e reset_execute na lista (reset_dry_run fora)", () => {
  assert.ok(portaDoExecute(code), "a porta do execute no workflow real");
  assert.equal(portaDoExecute(code.replace("    environment: production\n", "")), false, "sem environment, a porta fecha");
  assert.equal(portaDoExecute(code.replace("inputs.mode == 'execute'", "inputs.mode == 'dry-run'")), false, "sem mode=execute, a porta fecha");
  assert.equal(portaDoExecute(code.replace("|| inputs.task == 'reset_execute')", ")")), false, "sem a alternativa do reset_execute, a porta fecha");
  assert.equal(portaDoExecute(code.replace("|| inputs.task == 'reset_execute')", "|| inputs.task == 'reset_dry_run')")), false, "reset_dry_run no execute fecha a porta");
});
check("reset: o input ok existe, é texto e opcional; RESET_OK chega aos dois jobs por env, nunca num comando", () => {
  assert.match(code, /\n {6}ok:\n\s+description: .*\n\s+type: string\n\s+required: false\n\s+default: ""/);
  assert.match(code, /\n {6}RESET_OK: \$\{\{ inputs\.ok \}\}\n/);
  assert.equal([...code.matchAll(/RESET_OK: \$\{\{ inputs\.ok \}\}/g)].length, 2);
  assert.doesNotMatch(code, /run:.*\$\{\{\s*inputs\.ok/);
});
check("reset: as tarefas do workflow são as que o maintenance.sh aceita (menos esperar_indexacao, só do deploy)", () => {
  const bloco = code.match(/task:\n[\s\S]*?options:\n((?:\s+- \w+\n)+)/)[1];
  const opcoes = bloco.trim().split("\n").map((l) => l.trim().replace(/^- /, "")).sort();
  const aceites = [
    ...sh.match(/^  catalog_health \| .*\) ;;$/m)[0].replace(/\) ;;$/, "").split("|"),
    ...sh.match(/^  reset_dry_run \| reset_execute\) ;;$/m)[0].replace(/\) ;;$/, "").split("|"),
  ].map((t) => t.trim());
  assert.deepEqual(opcoes, aceites.filter((t) => t !== "esperar_indexacao").sort());
});
check("reset: o job execute e o WRITES do maintenance.sh falam das mesmas tarefas que escrevem", () => {
  const writes = sh.match(/^case "\$TASK" in (.*?)\) WRITES=true/m)[1].split("|").map((t) => t.trim()).sort();
  const lista = JSON.parse(code.match(/contains\(fromJSON\('(\[[^\]]*\])'\), inputs\.task\)/)[1]);
  if (/inputs\.task == 'reset_execute'/.test(code)) lista.push("reset_execute");
  assert.deepEqual(lista.sort(), writes);
  assert.ok(writes.includes("reset_execute") && !writes.includes("reset_dry_run"));
});

console.log("image_check — resumo e falhas (flyctl falso com linhas IC sintéticas)");
check("image_check: contagens, host, amostra e combinações saem no resumo", () => {
  const r = run("image_check", "dry-run", { FAKE_IC: IC_SINTETICO });
  assert.equal(r.status, 0);
  for (const frag of [
    "Catálogo indexado: **26** linhas. imageUrl: https **13**, http **8**, vazio **3**, inválido **2**. Com mais de um URL: **3**.",
    "Hosts mais frequentes (primeiro URL válido): cdn-sintetico.example (17).",
    "Amostra: **20** linhas com URL válido, ao acaso (https **10**, http **10**).",
    "Pedido com https, sem Referer, a cada linha http da amostra: 200 com imagem em **9** de **10**; com erro **1**.",
    "Resposta da amostra: OK sem Referer **18**; OK com Referer da app **18**;",
    "- **12** × esquema **https**: sem Referer **200/imagem**, com Referer da app **200/imagem**, redireciona **nao**, destino **-**.",
    "**Em resumo:** https 13, http 8, inválidas 2; amostra: 18 OK sem Referer, 18 OK com Referer da app",
    "✅ Leitura concluída (ver contagens)",
  ]) {
    assert.ok(r.summaryText.includes(frag), frag);
  }
});
check("image_check: host fora do formato de nome não sai, e o resumo diz quantos ficaram de fora", () => {
  const r = run("image_check", "dry-run", { FAKE_IC: IC_SINTETICO });
  assert.ok(r.summaryText.includes("Fora do formato de nome, não mostrados: 1."), "contagem de hosts fora");
  assert.doesNotMatch(r.summaryText, /::1/);
});
check("image_check: sem hosts com duas ou mais linhas, o resumo diz porquê", () => {
  const sem = IC_SINTETICO.split("\n").filter((l) => !l.startsWith("IC_HOST:")).join("\n");
  const r = run("image_check", "dry-run", { FAKE_IC: sem });
  assert.ok(r.summaryText.includes("Hosts mais frequentes (primeiro URL válido): nenhum com 2 ou mais linhas."));
});
check("image_check: linha fora do contrato não sai no stdout, no stderr nem no resumo", () => {
  const r = run("image_check", "dry-run", { FAKE_IC: IC_SINTETICO + "erro cru: https://loja-sintetica.example/a/SKU-SINTETICO-9?v=1\n" });
  assert.equal(r.status, 0);
  for (const texto of [r.stdout, r.stderr, r.summaryText]) {
    assert.doesNotMatch(texto, /:\/\//);
    assert.doesNotMatch(texto, /SKU-SINTETICO|loja-sintetica|\?v=/);
  }
});
check("image_check: exit 0 sem linha de contagens é falha, não verde", () => {
  const r = run("image_check", "dry-run", { FAKE_IC: "" });
  assert.equal(r.status, 2);
  assert.ok(r.summaryText.includes("❌ Falhou (código 2)"));
  assert.ok(r.summaryText.includes("a Fly não devolveu a linha de contagens: não li nada."));
});
check("image_check: IC_ERRO dá a causa classificada e nenhum detalhe", () => {
  const casos = [
    ["catalogo_falhou", "não consegui ler o catálogo na base de dados"],
    ["catalogo_mudou", "o catálogo mudou durante a leitura"],
    ["modulo_falhou", "não consegui carregar o cliente Prisma na Fly"],
  ];
  for (const [classe, texto] of casos) {
    const r = run("image_check", "dry-run", { FAKE_IC: `IC_ERRO: classe=${classe}\n`, FAKE_IC_RC: "1" });
    assert.equal(r.status, 1, classe);
    assert.ok(r.summaryText.includes(texto), classe);
    assert.ok(r.summaryText.includes("**Em resumo:** sem leitura"), classe);
  }
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

check("reset: o driver (scripts/tests/reset-maintenance.test.js) corre aqui, para entrar no test:deploy da CI", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/tests/reset-maintenance.test.js")], { cwd: ROOT, encoding: "utf8", timeout: 900000 });
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-1500));
});
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nmaintenance: todos os casos passaram");
