#!/usr/bin/env node
/* eslint-env node */
/**
 * Tarefa scale_memory (Decisão 41): muda a memória da única máquina da app de 512 para 1024 MB.
 *   (a) scripts/maintenance/scale-memory-plan.mjs: conta as máquinas, dá o id só ao flyctl (SM_ID), a memória e a CPU.
 *       Mais de uma máquina → sem SM_ID. JSON ilegível ou que não é lista → código 2.
 *   (b) scripts/ci/maintenance.sh scale_memory com flyctl falso que guarda o estado entre chamadas:
 *       dry-run só lê; execute troca com `machine update --vm-memory 1024 --yes` e confirma com machines list;
 *       já em 1024 não troca; duas máquinas recusa (código 3); se a Fly não confirmar, falha (código 1).
 *       Nunca corre a sonda de indexação (ssh) e nunca imprime o id completo.
 *   (c) mutações: sem a guarda de uma máquina, com 512 no comando, e com o id completo no resumo, cada uma tem de
 *       deixar um caso vermelho.
 * Isolamento: diretórios temporários e flyctl falso. Não chama a Fly.
 * Uso: node scripts/tests/scale-memory.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plano } from "../maintenance/scale-memory-plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAINT = path.join(ROOT, "scripts", "ci", "maintenance.sh");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scale-memory-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const ID = "9080e1c4a2b7d3";
const OUTRO_ID = "7c3a91b20f44d1";
const maquina = (id, memoria, extra = {}) => ({
  id,
  state: "started",
  region: "fra",
  config: { guest: { memory_mb: memoria, cpu_kind: "shared", cpus: 1 } },
  events: [],
  ...extra,
});
const UMA_512 = [maquina(ID, 512)];
const UMA_1024 = [maquina(ID, 1024)];
const DUAS = [maquina(ID, 512), maquina(OUTRO_ID, 512)];

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

console.log("scale-memory — plano (Node) e tarefa (bash, com flyctl falso)");

// --- (a) plano -----------------------------------------------------------------------------

await check("(a) uma máquina: id só para o flyctl, memória, CPU e prefixo de seis caracteres", async () => {
  const r = plano(JSON.stringify(UMA_512));
  assert.equal(r.codigo, 0);
  for (const linha of [`SM_MAQUINAS=1`, `SM_ID=${ID}`, `SM_MAQUINA=9080e1`, `SM_ESTADO=started`, `SM_MEMORIA_MB=512`, `SM_CPU=shared`, `SM_CPUS=1`]) {
    assert.ok(r.linhas.includes(linha), `falta ${linha}: ${r.linhas.join(" | ")}`);
  }
});

await check("(a) duas máquinas: conta-as, mas não dá id nenhum (não se escolhe uma)", async () => {
  const r = plano(JSON.stringify(DUAS));
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.linhas, ["SM_MAQUINAS=2"]);
});

await check("(a) lista vazia: zero máquinas", async () => {
  assert.deepEqual(plano("[]"), { linhas: ["SM_MAQUINAS=0"], codigo: 0 });
});

await check("(a) JSON ilegível ou que não é lista → código 2", async () => {
  assert.deepEqual(plano("{ truncado"), { linhas: ["SM_ERRO=json_ilegivel"], codigo: 2 });
  assert.deepEqual(plano('{"id":"x"}'), { linhas: ["SM_ERRO=formato_inesperado"], codigo: 2 });
});

await check("(a) id com espaços ou memória com texto livre saem como ?, nunca como texto", async () => {
  const r = plano(JSON.stringify([{ id: "abc def", config: { guest: { memory_mb: "512; rm -rf /", cpu_kind: "shared", cpus: 1 } } }]));
  assert.ok(r.linhas.includes("SM_ID=?"), r.linhas.join(" | "));
  assert.ok(r.linhas.includes("SM_MEMORIA_MB=?"), r.linhas.join(" | "));
  assert.ok(!r.linhas.join("\n").includes("rm -rf"), "o texto livre saiu");
});

// --- (b) tarefa em bash com flyctl falso ---------------------------------------------------

/** flyctl falso: `machines list` lê FAKE_ESTADO; `machine update` copia FAKE_APOS para FAKE_ESTADO se a memória for 1024. */
function flyctlFalso(dir) {
  const bin = path.join(dir, "flyctl");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "machines list"*) cat "$FAKE_ESTADO" ;;
  "machine update"*)
    if [ -n "$FAKE_APOS" ] && [[ "$*" == *"--vm-memory 1024"* ]]; then cp "$FAKE_APOS" "$FAKE_ESTADO"; fi
    if [ -n "$FAKE_FALHA" ]; then echo "detalhe-interno $*" >&2; exit 1; fi
    exit 0 ;;
  *) echo "fora do falso: $*" >&2; exit 9 ;;
esac
`
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Corre a tarefa scale_memory com um estado inicial. Devolve o código, o resumo e o log do flyctl. */
function correrTarefa(script, fase, { estado, apos, falha = false }) {
  const dir = fs.mkdtempSync(path.join(tmp, "run-"));
  const estadoFich = path.join(dir, "estado.json");
  const aposFich = path.join(dir, "apos.json");
  const log = path.join(dir, "fly.log");
  const resumoFich = path.join(dir, "summary.md");
  fs.writeFileSync(estadoFich, JSON.stringify(estado));
  fs.writeFileSync(aposFich, JSON.stringify(apos ?? estado));
  fs.writeFileSync(log, "");
  const r = spawnSync("bash", [script, "scale_memory", fase], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      FLYCTL: flyctlFalso(dir),
      FLY_APP: "teste",
      FAKE_ESTADO: estadoFich,
      FAKE_APOS: apos ? aposFich : "",
      FAKE_FALHA: falha ? "1" : "",
      FAKE_LOG: log,
      GITHUB_STEP_SUMMARY: resumoFich,
      GITHUB_OUTPUT: "",
    },
  });
  const resumo = fs.existsSync(resumoFich) ? fs.readFileSync(resumoFich, "utf8") : "";
  return { r, resumo, log: fs.readFileSync(log, "utf8") };
}

await check("(b) dry-run: só lê, diz o que o execute faria, e não imprime o id completo", async () => {
  const { r, resumo, log } = correrTarefa(MAINT, "dry-run", { estado: UMA_512 });
  assert.equal(r.status, 0, `saída ${r.status}: ${r.stderr}`);
  assert.ok(resumo.includes("passava a **1024** MB"), resumo);
  assert.ok(resumo.includes("memória **512** MB"), resumo);
  assert.ok(!log.includes("machine update"), `o dry-run chamou a troca: ${log}`);
  assert.ok(!resumo.includes(ID) && !(r.stdout + r.stderr).includes(ID), "o id completo saiu");
});

await check("(b) execute: troca com --vm-memory 1024 --yes, confirma com machines list, e não corre a sonda de indexação", async () => {
  const { r, resumo, log } = correrTarefa(MAINT, "execute", { estado: UMA_512, apos: UMA_1024 });
  assert.equal(r.status, 0, `saída ${r.status}: ${r.stdout}\n${r.stderr}`);
  assert.ok(log.includes(`machine update ${ID} --vm-memory 1024 --yes -a teste`), log);
  assert.ok(resumo.includes("Memória confirmada pela Fly: **1024** MB"), resumo);
  assert.ok(!/\bssh\b/.test(log), "a sonda de indexação (ssh) não pode correr nesta tarefa");
  assert.ok(!resumo.includes(ID) && !(r.stdout + r.stderr).includes(ID), "o id completo saiu");
});

await check("(b) execute com a máquina já em 1024 MB: não troca, e fica feito", async () => {
  const { r, resumo, log } = correrTarefa(MAINT, "execute", { estado: UMA_1024 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!log.includes("machine update"), log);
  assert.ok(resumo.includes("Já estava em 1024 MB"), resumo);
});

await check("(b) execute com duas máquinas: recusa com código 3, sem trocar nenhuma", async () => {
  const { r, resumo, log } = correrTarefa(MAINT, "execute", { estado: DUAS, apos: UMA_1024 });
  assert.equal(r.status, 3, `saída ${r.status}: ${r.stderr}`);
  assert.ok(!log.includes("machine update"), log);
  assert.ok(resumo.includes("Esperava exatamente 1 máquina e encontrei 2"), resumo);
});

await check("(b) execute em que a Fly não confirma 1024 MB: falha com código 1", async () => {
  const { r, resumo } = correrTarefa(MAINT, "execute", { estado: UMA_512 });
  assert.equal(r.status, 1, `saída ${r.status}`);
  assert.ok(resumo.includes("a Fly não confirmou 1024 MB"), resumo);
});

await check("(b) execute em que o flyctl machine update falha sem aplicar: código 1, lê a Fly outra vez, e o detalhe e o id não saem", async () => {
  const { r, resumo, log } = correrTarefa(MAINT, "execute", { estado: UMA_512, falha: true });
  assert.equal(r.status, 1, `saída ${r.status}`);
  assert.ok(resumo.includes("o flyctl machine update falhou (código 1). Memória lida agora: 512 MB"), resumo);
  assert.ok(log.includes("machines list"), "a Fly tem de ser lida outra vez depois da falha");
  assert.ok(!resumo.includes("detalhe-interno") && !(r.stdout + r.stderr).includes("detalhe-interno"), "o detalhe do flyctl saiu");
  assert.ok(!resumo.includes(ID) && !(r.stdout + r.stderr).includes(ID), "o id completo saiu");
});

await check("(b) execute em que o flyctl falha depois de aplicar a troca: a leitura diz 1024 MB, e não diz que a memória não mudou", async () => {
  const { r, resumo } = correrTarefa(MAINT, "execute", { estado: UMA_512, apos: UMA_1024, falha: true });
  assert.equal(r.status, 1, `saída ${r.status}`);
  assert.ok(resumo.includes("Memória lida agora: 1024 MB"), resumo);
  assert.ok(!resumo.includes("a memória não mudou"), resumo);
});

await check("(b) execute em que a memória fica 1024 MB mas a máquina não está started: código 1", async () => {
  const parada = [maquina(ID, 1024, { state: "stopped" })];
  const { r, resumo } = correrTarefa(MAINT, "execute", { estado: UMA_512, apos: parada });
  assert.equal(r.status, 1, `saída ${r.status}`);
  assert.ok(resumo.includes("não está iniciada (estado: stopped)"), resumo);
});

await check("(b) memória atual ilegível: recusa com código 2 antes de qualquer troca", async () => {
  const semMemoria = [{ id: ID, state: "started", region: "fra", config: { guest: { cpu_kind: "shared", cpus: 1 } }, events: [] }];
  const { r, resumo, log } = correrTarefa(MAINT, "execute", { estado: semMemoria });
  assert.equal(r.status, 2, `saída ${r.status}`);
  assert.ok(!log.includes("machine update"), log);
  assert.ok(resumo.includes("não consegui ler a memória atual"), resumo);
});

// --- (c) mutações --------------------------------------------------------------------------

/** Cópia do maintenance.sh com uma troca, na mesma pasta (o ROOT continua certo). Quem chama apaga a cópia. */
function mutanteDoMaintenance(nome, antigo, novo) {
  const texto = fs.readFileSync(MAINT, "utf8");
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  const destino = path.join(path.dirname(MAINT), `.mutante-${nome}-${process.pid}.sh`);
  fs.writeFileSync(destino, texto.replace(antigo, () => novo));
  return destino;
}

await check("mutação: sem a guarda de uma máquina, o caso das duas máquinas tem de ficar vermelho", async () => {
  const m = mutanteDoMaintenance("sem-guarda-contagem", 'elif [ "$(campo_sm SM_MAQUINAS)" != "1" ]; then', "elif false; then");
  try {
    const { r } = correrTarefa(m, "execute", { estado: DUAS, apos: UMA_1024 });
    assert.notEqual(r.status, 3, "o caso (b) das duas máquinas tem de apanhar a mutação");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await check("mutação: 512 no comando de troca, o caso do execute tem de ficar vermelho", async () => {
  const m = mutanteDoMaintenance("memoria-512", '--vm-memory 1024 --yes -a "$APP"', '--vm-memory 512 --yes -a "$APP"');
  try {
    const { r } = correrTarefa(m, "execute", { estado: UMA_512, apos: UMA_1024 });
    assert.notEqual(r.status, 0, "o caso (b) do execute tem de apanhar a mutação");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await check("mutação: o id completo no resumo do dry-run, o caso de privacidade tem de ficar vermelho", async () => {
  const m = mutanteDoMaintenance("id-completo", "\\`$(campo_sm SM_MAQUINA)\\`", "\\`$SM_ID\\`");
  try {
    const { resumo } = correrTarefa(m, "dry-run", { estado: UMA_512 });
    assert.throws(() => assert.ok(!resumo.includes(ID)), "o caso (b) tem de apanhar o id completo");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await check("mutação: o id completo na causa de falha do machine update, o caso de privacidade tem de ficar vermelho", async () => {
  const m = mutanteDoMaintenance("id-na-falha", "falhou (código $UPD_RC).", "falhou na máquina $SM_ID (código $UPD_RC).");
  try {
    const { resumo } = correrTarefa(m, "execute", { estado: UMA_512, falha: true });
    assert.throws(() => assert.ok(!resumo.includes(ID)), "o caso de falha tem de apanhar o id completo");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

if (falhas) {
  console.error(`\nscale-memory: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nscale-memory: todos os casos passaram");
