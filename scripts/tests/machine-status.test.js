#!/usr/bin/env node
/* eslint-env node */
/**
 * Tarefa machine_status (só leitura, PR de ronda 3 do PR 5, pedido do arquiteto depois do worker_morto de 14:46Z).
 *   (a) scripts/maintenance/machine-status.mjs: uma linha MS: por máquina, com estado, região, memória, código,
 *       sinal, OOM e instante da última saída. Valor fora de token vira "?". Sem campos esperados, só os nomes das
 *       chaves do evento, nunca os valores. JSON ilegível ou que não é lista → código 2.
 *   (b) scripts/ci/maintenance.sh machine_status com flyctl falso: o resumo tem contagens e estados, o id sai
 *       truncado (seis caracteres), e as linhas de OOM do machine status contam-se sem sair o texto.
 *       execute é recusado sem chamar a Fly.
 *   (c) mutações: sem a guarda do execute o caso (b) tem de ficar vermelho; com o id completo no resumo, também.
 * Isolamento: diretórios temporários, flyctl falso. Não chama a Fly.
 * Uso: node scripts/tests/machine-status.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resumir } from "../maintenance/machine-status.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAINT = path.join(ROOT, "scripts", "ci", "maintenance.sh");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "machine-status-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const ID_COMPLETO = "1854e9d0c50628";
const MAQUINAS = [
  {
    id: ID_COMPLETO,
    state: "started",
    region: "mad",
    config: { guest: { memory_mb: 1024 } },
    events: [
      { type: "launch", status: "created", timestamp: "2026-10-20T14:40:00Z", request: {} },
      {
        type: "exit",
        status: "stopped",
        timestamp: "2026-10-20T14:49:27Z",
        request: { exit_event: { exit_code: 137, guest_signal: 9, oom_killed: true, requested_stop: false } },
      },
    ],
  },
  { id: "7c3a91b20f44d1", state: "stopped", region: "mad", config: { guest: { memory_mb: 512 } }, events: [] },
];

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

console.log("machine-status — leitura do JSON de machines list, sem id completo");

await check("(a) uma linha MS: por máquina, com estado, região, memória e a última saída", async () => {
  const { linhas, codigo } = resumir(JSON.stringify(MAQUINAS));
  assert.equal(codigo, 0);
  assert.equal(linhas[0], "MS: maquinas=2");
  const primeira = linhas[1];
  for (const parte of ["maquina=1854e9", "estado=started", "regiao=mad", "memoria_mb=1024", "saida=ok", "codigo=137", "sinal=9", "oom=sim", "quando=2026-10-20T14:49:27.000Z"]) {
    assert.ok(primeira.includes(parte), `falta ${parte} em: ${primeira}`);
  }
  assert.ok(linhas[2].includes("saida=nenhuma"), "máquina sem eventos de saída");
});

await check("(a) instante: número em milissegundos (como a Machines API) vira ISO UTC; texto de data também", async () => {
  const dados = [{ id: "abc123", state: "started", region: "fra", config: { guest: { memory_mb: 512 } }, events: [{ type: "exit", timestamp: 1792510401353, request: { exit_event: { exit_code: 137, oom_killed: true } } }] }];
  assert.ok(resumir(JSON.stringify(dados)).linhas[1].includes("quando=2026-10-20T15:33:21.353Z"), resumir(JSON.stringify(dados)).linhas[1]);
});

await check("(a) CPU da máquina sai na linha: tipo e número de CPUs, para a verificação pré-deploy", async () => {
  const dados = [{ id: "abc123", state: "started", region: "fra", config: { guest: { memory_mb: 1024, cpu_kind: "shared", cpus: 1 } }, events: [] }];
  const linha = resumir(JSON.stringify(dados)).linhas[1];
  assert.ok(linha.includes("memoria_mb=1024 cpu_kind=shared cpus=1"), linha);
});

await check("(a) o id completo não sai do parser", async () => {
  const { linhas } = resumir(JSON.stringify(MAQUINAS));
  assert.ok(!linhas.join("\n").includes(ID_COMPLETO), "o id completo saiu");
  assert.ok(linhas[1].includes("maquina=1854e9"), "o prefixo de seis caracteres tem de sair");
});

await check("(a) evento de saída sem os campos esperados: só os nomes das chaves, nunca os valores", async () => {
  const dados = [
    { id: "abcdef123456", state: "started", region: "mad", config: { guest: { memory_mb: 256 } }, events: [{ type: "exit", timestamp: "2026-10-20T10:00:00Z", request: { segredo_valor: "NAO_PODE_SAIR" } }] },
  ];
  const { linhas } = resumir(JSON.stringify(dados));
  assert.ok(linhas[1].includes("saida=evento_sem_campos"), linhas[1]);
  assert.ok(linhas[1].includes("chaves=type|timestamp|request"), linhas[1]);
  assert.ok(linhas[1].includes("chaves_request=segredo_valor"), linhas[1]);
  assert.ok(!linhas.join("\n").includes("NAO_PODE_SAIR"), "um valor saiu");
});

await check("(a) valor fora de token simples vira ? e nunca entra como texto", async () => {
  const dados = [{ id: "abc", state: "started; rm -rf /", region: "mad ok", config: {}, events: [] }];
  const { linhas } = resumir(JSON.stringify(dados));
  assert.ok(linhas[1].includes("estado=?"), linhas[1]);
  assert.ok(linhas[1].includes("regiao=?"), linhas[1]);
  assert.ok(linhas[1].includes("memoria_mb=nenhum"), linhas[1]);
});

await check("(a) oom ausente vira ? e oom falso vira nao", async () => {
  const sem = [{ id: "abc", state: "started", region: "mad", config: {}, events: [{ type: "exit", timestamp: "2026-10-20T10:00:00Z", request: { exit_event: { exit_code: 0 } } }] }];
  const com = [{ id: "abc", state: "started", region: "mad", config: {}, events: [{ type: "exit", timestamp: "2026-10-20T10:00:00Z", request: { exit_event: { exit_code: 0, oom_killed: false } } }] }];
  assert.ok(resumir(JSON.stringify(sem)).linhas[1].includes("oom=?"));
  assert.ok(resumir(JSON.stringify(com)).linhas[1].includes("oom=nao"));
});

await check("(a) JSON ilegível ou que não é lista → código 2, sem conteúdo", async () => {
  assert.deepEqual(resumir("{ truncado"), { linhas: ["MS: erro=json_ilegivel"], codigo: 2 });
  assert.deepEqual(resumir('{"id":"x"}'), { linhas: ["MS: erro=formato_inesperado"], codigo: 2 });
});

await check("(a) lista vazia → zero máquinas, código 0", async () => {
  assert.deepEqual(resumir("[]"), { linhas: ["MS: maquinas=0"], codigo: 0 });
});

// --- maintenance.sh com flyctl falso -------------------------------------------------------

/** flyctl falso: `machines list --json` devolve o JSON de FAKE_MACHINES; `machine status <id>` tem texto de OOM por id. */
function flyctlFalso(dir) {
  const bin = path.join(dir, "flyctl");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "machines list"*) cat "$FAKE_MACHINES" ;;
  "machine status"*)
    case "$*" in
      *${ID_COMPLETO}*) printf 'Machine %s\\nexit oom_killed=true\\nkernel: Out of memory: Killed process 42\\nroom 3\\n' "${ID_COMPLETO}" ;;
      *) printf 'start ok\\n' ;;
    esac ;;
  *) echo "fora do falso: $*" >&2; exit 9 ;;
esac
`
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Corre o maintenance.sh (ou uma cópia) com o flyctl falso. Devolve o resultado e o resumo escrito. */
function correrTarefa(script, fase, extra = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "run-"));
  const machines = path.join(dir, "machines.json");
  fs.writeFileSync(machines, JSON.stringify(MAQUINAS));
  const log = path.join(dir, "fly.log");
  const resumoFich = path.join(dir, "summary.md");
  fs.writeFileSync(log, "");
  const r = spawnSync("bash", [script, "machine_status", fase], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      FLYCTL: flyctlFalso(dir),
      FLY_APP: "teste",
      FAKE_MACHINES: machines,
      FAKE_LOG: log,
      GITHUB_STEP_SUMMARY: resumoFich,
      GITHUB_OUTPUT: "",
      ...extra,
    },
  });
  const resumo = fs.existsSync(resumoFich) ? fs.readFileSync(resumoFich, "utf8") : "";
  return { r, resumo, log: fs.readFileSync(log, "utf8"), dir };
}

await check("(b) dry-run: resumo com contagens, estados, OOM e linhas de OOM por máquina, sem o id completo", async () => {
  const { r, resumo } = correrTarefa(MAINT, "dry-run");
  assert.equal(r.status, 0, `saída ${r.status}: ${r.stderr}`);
  assert.ok(resumo.includes("Máquinas da app: **2**."), resumo);
  assert.ok(resumo.includes("estado **started**"), resumo);
  assert.ok(resumo.includes("código **137**"), resumo);
  assert.ok(resumo.includes("OOM **sim**"), resumo);
  assert.ok(resumo.includes("Linhas de OOM no machine status, máquina `1854e9`: **2**."), resumo);
  assert.ok(!resumo.includes(ID_COMPLETO), "o id completo saiu no resumo");
  assert.ok(!(r.stdout + r.stderr).includes(ID_COMPLETO), "o id completo saiu no log");
  assert.ok(resumo.includes("Sem saída registada."), "a máquina sem eventos de saída tem de dizer isso, não código vazio");
  assert.ok(!resumo.includes("código ****"), "não pode sair código vazio");
});

await check("(b) o flyctl é chamado só com comandos de leitura (machines list e machine status)", async () => {
  const { log } = correrTarefa(MAINT, "dry-run");
  assert.ok(log.includes(`machines list -a teste --json`), log);
  assert.ok(log.includes(`machine status ${ID_COMPLETO} -a teste`), log);
  assert.ok(!/\b(create|destroy|update|start|stop|restart|scale|deploy)\b/.test(log), log);
});

await check("(b) execute é recusado para esta tarefa: código 64 e a Fly não é chamada", async () => {
  const marca = path.join(tmp, "fly-chamada");
  const espiao = path.join(tmp, "flyctl-espiao");
  fs.writeFileSync(espiao, `#!/usr/bin/env bash\ntouch "${marca}"\nexit 0\n`);
  fs.chmodSync(espiao, 0o755);
  const r = spawnSync("bash", [MAINT, "machine_status", "execute"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH, FLYCTL: espiao, FLY_APP: "teste", GITHUB_STEP_SUMMARY: "/dev/null", GITHUB_OUTPUT: "" },
  });
  assert.equal(r.status, 64, r.stderr);
  assert.equal(fs.existsSync(marca), false, "a Fly não foi chamada");
});

// --- mutações ------------------------------------------------------------------------------

/** Cópia do maintenance.sh com uma troca, na mesma pasta (o ROOT continua certo). Quem chama apaga a cópia. */
function mutanteDoMaintenance(nome, antigo, novo) {
  const texto = fs.readFileSync(MAINT, "utf8");
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  const destino = path.join(path.dirname(MAINT), `.mutante-${nome}-${process.pid}.sh`);
  fs.writeFileSync(destino, texto.replace(antigo, () => novo));
  return destino;
}

await check("mutação: sem a guarda do execute, a tarefa chama a Fly (o caso do execute tem de ficar vermelho)", async () => {
  const m = mutanteDoMaintenance("sem-guarda", "  indexing_status | machine_status | esperar_indexacao | image_check)\n    if", "  indexing_status | esperar_indexacao | image_check)\n    if");
  try {
    const marca = path.join(tmp, "fly-chamada-mutante");
    const espiao = path.join(tmp, "flyctl-espiao-mutante");
    fs.writeFileSync(espiao, `#!/usr/bin/env bash\ntouch "${marca}"\nexit 0\n`);
    fs.chmodSync(espiao, 0o755);
    spawnSync("bash", [m, "machine_status", "execute"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH, FLYCTL: espiao, FLY_APP: "teste", GITHUB_STEP_SUMMARY: "/dev/null", GITHUB_OUTPUT: "" },
    });
    assert.equal(fs.existsSync(marca), true, "a mutação tem de chamar a Fly; senão o caso do execute não está a testar a guarda");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await check("mutação: o id completo no resumo das linhas de OOM (o caso de privacidade tem de ficar vermelho)", async () => {
  const m = mutanteDoMaintenance("id-completo", 'echo "MS_OOM: maquina=${ID_MS:0:6} linhas=${N_OOM:-0}"', 'echo "MS_OOM: maquina=${ID_MS} linhas=${N_OOM:-0}"');
  try {
    const { resumo } = correrTarefa(m, "dry-run");
    assert.throws(() => assert.ok(!resumo.includes(ID_COMPLETO)), "o caso (b) tem de apanhar o id completo");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

if (falhas) {
  console.error(`\nmachine-status: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nmachine-status: todos os casos passaram");
