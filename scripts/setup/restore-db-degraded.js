import { PrismaClient } from "@prisma/client";
import { clearDbDegraded, dbDegradedFlagPath, readDbDegraded } from "../../lib/health/dbDegraded.js";

/**
 * Saída do modo degradado (Decisão 34, Lote 0). Dry-run por omissão.
 *
 *   node scripts/setup/restore-db-degraded.js            verifica e diz o que faria
 *   node scripts/setup/restore-db-degraded.js --execute  apaga a flag só se integrity_check der ok
 *
 * O ficheiro da BD é reposto antes, à mão, com a app parada (snapshot do volume ou backup).
 * Com --execute, a linha de registo em docs/execucoes.md tem de existir antes da corrida.
 */

const execute = process.argv.includes("--execute");

async function integrityRows() {
  // Só leitura: PRAGMA integrity_check não escreve. Cliente próprio, fora do modo degradado.
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe("PRAGMA integrity_check;");
    return rows.map((row) => String(Object.values(row)[0]));
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  const state = readDbDegraded();
  if (!state) {
    console.log(`[restore] Sem flag DB_DEGRADED em ${dbDegradedFlagPath()}. Nada a fazer.`);
    return 0;
  }

  console.log(`[restore] Modo degradado ativo: ${state.cause} (desde ${state.at ?? "data desconhecida"}).`);

  let rows;
  try {
    rows = await integrityRows();
  } catch (err) {
    console.error(`[restore] integrity_check não correu: ${err?.message || err}. Flag mantida.`);
    return 1;
  }

  console.log(`[restore] integrity_check: ${rows.join(" | ")}`);
  if (!(rows.length === 1 && rows[0] === "ok")) {
    console.error("[restore] BD ainda não íntegra. Flag mantida.");
    return 1;
  }

  if (!execute) {
    console.log("[restore] Dry-run. Com --execute a flag é apagada. Registar a execução em docs/execucoes.md antes.");
    return 0;
  }

  clearDbDegraded();
  console.log(`[restore] Flag removida (${dbDegradedFlagPath()}). A app deixa de bloquear escritas.`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("[restore] Erro inesperado:", err?.message || err);
    process.exitCode = 1;
  });
