#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const errorsPath = path.join(projectRoot, "results", "errors.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envInt(name, fallback) {
  const parsed = parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function appendErrorLog(entry) {
  try {
    await fs.mkdir(path.dirname(errorsPath), { recursive: true });
    let list = [];
    try {
      const raw = await fs.readFile(errorsPath, "utf8");
      const parsed = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];
    }
    list.push(entry);
    await fs.writeFile(errorsPath, JSON.stringify(list, null, 2), "utf8");
  } catch {
    // Não interromper daemon por falha de logging.
  }
}

function runOneCycle(syncLimitArg) {
  return new Promise((resolve, reject) => {
    const args = ["scripts/run-live-import.js"];
    if (syncLimitArg !== null) args.push(String(syncLimitArg));

    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`run-live-import terminou com exit code ${code}`));
    });
  });
}

async function main() {
  const cycleDelayMin = envInt("SYNC_INTERVAL_MINUTES", 15);
  const syncLimit = envInt("SYNC_LIMIT", 0);
  const syncLimitArg = syncLimit > 0 ? syncLimit : null;

  console.log("[live-sync-daemon] Iniciado.");
  console.log(`[live-sync-daemon] Intervalo entre ciclos: ${cycleDelayMin} min`);
  console.log(
    `[live-sync-daemon] SYNC_LIMIT efetivo: ${syncLimitArg === null ? "sem limite (0)" : syncLimitArg}`
  );

  for (;;) {
    const startedAt = new Date().toISOString();
    console.log(`\n[live-sync-daemon] Novo ciclo @ ${startedAt}`);

    try {
      await runOneCycle(syncLimitArg);
      console.log("[live-sync-daemon] Ciclo concluído com sucesso.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[live-sync-daemon] Ciclo falhou:", message);
      await appendErrorLog({
        operacao: "live_sync_daemon.cycle",
        mensagem: message,
        timestamp: new Date().toISOString(),
        contexto: { cycleDelayMin, syncLimit },
      });
    }

    await sleep(cycleDelayMin * 60 * 1000);
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[live-sync-daemon] Falha fatal:", message);
  await appendErrorLog({
    operacao: "live_sync_daemon.fatal",
    mensagem: message,
    timestamp: new Date().toISOString(),
  });
  process.exit(1);
});
