/* eslint-env node */
/**
 * Isola a fila de curadoria dos testes que leem o catálogo com `count` simulado. A fila de
 * produção (server/data/curation-queue.json) é ignorada pelo git e não existe em CI. Sem este
 * isolamento, a fila em falta com catálogo populado cai na regra de bootstrap (flag DB_DEGRADED).
 *
 * Tem de ser o PRIMEIRO import do teste: os módulos lêem CURATION_DATA_DIR e DATABASE_URL ao
 * carregar, e o ESM avalia os imports pela ordem em que aparecem.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curation-isolado-"));
process.env.CURATION_DATA_DIR = dir;
process.env.DATABASE_URL = `file:${path.join(dir, "dev.sqlite")}`;
fs.writeFileSync(path.join(dir, "curation-queue.json"), JSON.stringify({ version: 1, updatedAt: null, items: [] }), "utf8");
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
