#!/usr/bin/env node
/**
 * scripts/deploy.sh — as quatro guardas (decisão 28/09/2026, 14:16).
 *
 * Cada caso monta um repo temporário (origin bare + clone de trabalho), copia o
 * deploy.sh real para lá, e põe um `flyctl` falso no PATH que só regista a chamada.
 * Um caso "recusado" tem de sair com erro E não chamar o flyctl.
 * Uso: node scripts/tests/deploy-guards.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY_SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "deploy.sh");
const MAINTENANCE_SH = path.resolve(path.dirname(DEPLOY_SH), "ci", "maintenance.sh");
const CHECK_NO_INDEXING = path.resolve(path.dirname(DEPLOY_SH), "maintenance", "check-no-indexing.mjs");

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

// git isolado da configuração do utilizador (hooks, assinatura, etc.).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} falhou: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (cwd, ...args) => sh(cwd, "git", args);

const suiteScript = (ok) => `node -e "process.exit(${ok ? 0 : 1})"`;

/**
 * Repo pronto a deployar: main, limpo, igual a origin/main, suites a passar.
 * @param {{ failingSuite?: string, suiteLeavesFile?: boolean }} [opts]
 */
function setupRepo(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-guards-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  const marker = path.join(root, "flyctl-called");
  const busy = path.join(root, "busy");
  const illegible = path.join(root, "ilegivel");

  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", work);

  const scripts = {};
  for (const s of ["test:franchise", "test:sync-safety", "test:health-gate"]) {
    scripts[s] = suiteScript(opts.failingSuite !== s);
  }
  if (opts.suiteLeavesFile) scripts["test:health-gate"] = `node -e "require('fs').writeFileSync('leftover.txt','x')"`;
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "t", private: true, scripts }, null, 2));
  fs.writeFileSync(path.join(work, ".gitignore"), "ignored.txt\n");
  fs.mkdirSync(path.join(work, "scripts", "ci"), { recursive: true });
  fs.mkdirSync(path.join(work, "scripts", "maintenance"));
  fs.writeFileSync(path.join(work, "scripts", "deploy.sh"), opts.deployScript ?? fs.readFileSync(DEPLOY_SH, "utf8"));
  // DBG-156: a espera de indexação corre o maintenance.sh e a sonda, por isso ambos entram no repo temporário.
  fs.copyFileSync(MAINTENANCE_SH, path.join(work, "scripts", "ci", "maintenance.sh"));
  fs.copyFileSync(CHECK_NO_INDEXING, path.join(work, "scripts", "maintenance", "check-no-indexing.mjs"));
  fs.writeFileSync(path.join(work, "README.md"), "x\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "-u", "origin", "main");

  // flyctl falso. `ssh` é a sonda da espera: sai livre, ou com indexação (ficheiro busy), ou ilegível
  // (ficheiro ilegivel). Não escreve no marcador. Qualquer outro comando (o deploy) regista-se nele.
  fs.mkdirSync(bin);
  const fake = path.join(bin, "flyctl");
  fs.writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'if [ "$1" = "ssh" ]; then',
      `  if [ -f "${illegible}" ]; then echo "erro de ssh" >&2; exit 3; fi`,
      `  if [ -f "${busy}" ]; then echo "[check-no-indexing] INDEXAÇÃO A DECORRER"; exit 1; fi`,
      "  exit 0",
      "fi",
      `echo "$@" > "${marker}"`,
      "",
    ].join("\n")
  );
  fs.chmodSync(fake, 0o755);

  return { root, origin, work, bin, marker, busy, illegible };
}

function runDeploy(repo) {
  const r = spawnSync("bash", ["scripts/deploy.sh"], {
    cwd: repo.work,
    // Janela da espera em zero: o teste não pode dormir 15 min.
    env: { ...GIT_ENV, PATH: `${repo.bin}:${process.env.PATH}`, WAIT_STEP_SECONDS: "0", WAIT_MAX_ATTEMPTS: "2", GATE_REPEAT_SECONDS: "0" },
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout + r.stderr, flyctl: fs.existsSync(repo.marker) ? fs.readFileSync(repo.marker, "utf8").trim() : null };
}

/** O padrão é procurado SÓ na linha de recusa — as linhas "guarda N ok" também dizem
 *  "guarda N", e um teste que casasse com elas passava pela guarda errada. */
function assertRefused(r, guardPattern) {
  assert.notEqual(r.status, 0, `devia sair com erro:\n${r.out}`);
  assert.equal(r.flyctl, null, "flyctl não podia ter sido chamado");
  const refusal = r.out.split("\n").find((l) => l.includes("RECUSADO")) || "";
  assert.match(refusal, guardPattern, `linha de recusa: ${refusal || "(nenhuma)"}`);
}

check("tudo certo — corre flyctl deploy -a alterpop-importer-app e imprime o commit", () => {
  const repo = setupRepo();
  const r = runDeploy(repo);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.flyctl, "deploy -a alterpop-importer-app");
  const sha = git(repo.work, "rev-parse", "HEAD");
  assert.match(r.out, new RegExp(`vai para produção: ${sha} init`));
});

check("espera (DBG-156) — indexação a decorrer ao fim da espera → recusado, flyctl deploy não é chamado", () => {
  const repo = setupRepo();
  fs.writeFileSync(repo.busy, "");
  assertRefused(runDeploy(repo), /espera: indexação a decorrer ao fim de 15 min/);
});
check("espera (DBG-156) — estado da indexação ilegível → recusado, flyctl deploy não é chamado", () => {
  const repo = setupRepo();
  fs.writeFileSync(repo.illegible, "");
  assertRefused(runDeploy(repo), /espera: indexação a decorrer ao fim de 15 min, ou estado ilegível/);
});
check("mutação: deploy.sh sem a espera chama o flyctl com indexação a decorrer — o caso acima tem de ficar vermelho", () => {
  const original = fs.readFileSync(DEPLOY_SH, "utf8");
  const semEspera = original.replace(/if ! bash scripts\/ci\/maintenance\.sh esperar_indexacao dry-run; then\n[^\n]*\nfi\n/, "");
  assert.notEqual(semEspera, original, "a mutação não se aplicou");
  const repo = setupRepo({ deployScript: semEspera });
  fs.writeFileSync(repo.busy, "");
  const r = runDeploy(repo);
  assert.equal(r.flyctl, "deploy -a alterpop-importer-app", "o mutante tem de chamar o flyctl deploy");
  assert.throws(() => assertRefused(r, /espera: indexação/));
});

check("guarda 1 — branch que não é main → recusado", () => {
  const repo = setupRepo();
  git(repo.work, "checkout", "-q", "-b", "fix/qualquer");
  assertRefused(runDeploy(repo), /guarda 1: branch atual é 'fix\/qualquer'/);
});

check("guarda 2 — ficheiro seguido alterado → recusado", () => {
  const repo = setupRepo();
  fs.appendFileSync(path.join(repo.work, "README.md"), "mudança\n");
  assertRefused(runDeploy(repo), /guarda 2: working tree não está limpo \(antes das suites\)/);
});

check("guarda 2 — ficheiro por seguir fora do .gitignore → recusado (caso real: collection-image-audit.html)", () => {
  const repo = setupRepo();
  fs.writeFileSync(path.join(repo.work, "collection-image-audit.html"), "<html></html>");
  assertRefused(runDeploy(repo), /guarda 2/);
});

check("guarda 2 — ficheiro no .gitignore não conta", () => {
  const repo = setupRepo();
  fs.writeFileSync(path.join(repo.work, "ignored.txt"), "x");
  const r = runDeploy(repo);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.flyctl);
});

check("guarda 2 (segunda passagem) — suite deixa ficheiro no disco → recusado depois das suites", () => {
  const repo = setupRepo({ suiteLeavesFile: true });
  assertRefused(runDeploy(repo), /guarda 2: working tree não está limpo \(depois das suites\)/);
});

check("guarda 3 — main à frente de origin/main (commit por fazer push) → recusado", () => {
  const repo = setupRepo();
  fs.writeFileSync(path.join(repo.work, "novo.txt"), "x");
  git(repo.work, "add", "novo.txt");
  git(repo.work, "commit", "-q", "-m", "local");
  assertRefused(runDeploy(repo), /guarda 3: main local ≠ origin\/main \(1 à frente, 0 atrás\)/);
});

check("guarda 3 — main atrás de origin/main (caso real 28/09: merge do PR ainda não puxado) → recusado", () => {
  const repo = setupRepo();
  const other = path.join(repo.root, "other");
  git(repo.root, "clone", "-q", repo.origin, other);
  fs.writeFileSync(path.join(other, "merge.txt"), "x");
  git(other, "add", "merge.txt");
  git(other, "commit", "-q", "-m", "merge do PR");
  git(other, "push", "-q", "origin", "main");
  assertRefused(runDeploy(repo), /guarda 3: main local ≠ origin\/main \(0 à frente, 1 atrás\)/);
});

for (const suite of ["test:franchise", "test:sync-safety", "test:health-gate"]) {
  check(`guarda 4 — ${suite} falha → recusado`, () => {
    const repo = setupRepo({ failingSuite: suite });
    assertRefused(runDeploy(repo), new RegExp(`guarda 4: ${suite} falhou`));
  });
}

check("ordem — branch errado E working tree sujo: pára na guarda 1", () => {
  const repo = setupRepo();
  git(repo.work, "checkout", "-q", "-b", "outra");
  fs.appendFileSync(path.join(repo.work, "README.md"), "x\n");
  assertRefused(runDeploy(repo), /guarda 1/);
});

// Memória da máquina (Decisão 40): fixada em fly.toml, e nenhum script de deploy a sobrepõe.
const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VM_MEMORIA = /^\[\[vm\]\]\n\s+memory = "1gb"$/m;
const COMANDO_DE_MEMORIA = /fly\s+scale|flyctl\s+scale|machines?\s+update|--vm-memory/g;
/**
 * Ocorrências do comando de memória em maintenance.sh fora do bloco scale_memory (Decisão 41). 0 é o certo.
 * -1 se o bloco não existir.
 */
function comandoDeMemoriaForaDoBloco(maint) {
  const bloco = /^  scale_memory\)\n([\s\S]*?)^    ;;$/m.exec(maint);
  if (!bloco) return -1;
  return (maint.match(COMANDO_DE_MEMORIA) || []).length - (bloco[1].match(COMANDO_DE_MEMORIA) || []).length;
}
check("memória da máquina fixada em fly.toml: [[vm]] com 1gb (1024 MB); o deploy não a muda, só scale_memory (Decisão 41)", () => {
  const toml = fs.readFileSync(path.join(RAIZ_REPO, "fly.toml"), "utf8");
  assert.match(toml, VM_MEMORIA, "fly.toml tem de fixar 1gb em [[vm]]");
  for (const rel of ["scripts/deploy.sh", ".github/workflows/deploy.yml", "Dockerfile"]) {
    const texto = fs.readFileSync(path.join(RAIZ_REPO, rel), "utf8");
    assert.doesNotMatch(texto, /fly\s+scale|flyctl\s+scale|machines?\s+update|--vm-memory/, `${rel} não pode mudar a memória da máquina`);
  }
  const maint = fs.readFileSync(path.join(RAIZ_REPO, "scripts/ci/maintenance.sh"), "utf8");
  assert.equal(comandoDeMemoriaForaDoBloco(maint), 0, "o comando de memória em maintenance.sh só pode estar dentro de scale_memory");
  assert.equal((maint.match(/--vm-memory 1024/g) || []).length, 1, "um só comando de memória, com 1024");
});
check("mutação: comando de memória fora do bloco scale_memory faz o caso ficar vermelho", () => {
  const maint = fs.readFileSync(path.join(RAIZ_REPO, "scripts/ci/maintenance.sh"), "utf8");
  const mutado = maint.replace("  machine_status)\n", "  machine_status)\n    flyctl machine update x --vm-memory 512\n");
  assert.notEqual(mutado, maint, "a âncora tem de existir");
  assert.notEqual(comandoDeMemoriaForaDoBloco(mutado), 0, "o caso tem de apanhar o comando fora do bloco");
});
check("mutação: memória de 512 MB em fly.toml faz o caso da memória ficar vermelho", () => {
  const toml = fs.readFileSync(path.join(RAIZ_REPO, "fly.toml"), "utf8");
  const mutado = toml.replace('memory = "1gb"', 'memory = "512mb"');
  assert.notEqual(mutado, toml, "a mutação tem de mudar o fly.toml");
  assert.throws(() => assert.match(mutado, VM_MEMORIA), "o caso da memória tem de apanhar 512 MB");
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ndeploy-guards: todos os casos passaram");
