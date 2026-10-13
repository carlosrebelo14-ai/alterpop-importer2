#!/usr/bin/env node
/* eslint-env node */
// Resume data/character-pages-cycle-state.json só com estados e contagens (sem handles, SKUs nem texto
// livre), para poder ir para logs públicos. Só lê. Números e booleanos passam; listas e objetos viram
// contagens; texto só nas chaves de estado conhecidas.
//
// Uso: node scripts/maintenance/character-cycle-summary.js
import fs from "node:fs";
import path from "node:path";

const STATE_KEYS = new Set(["status", "ranAt", "state", "mode", "decision"]);
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
const file = path.join(dataDir, "character-pages-cycle-state.json");

let raw;
try {
  raw = fs.readFileSync(file, "utf8");
} catch (err) {
  console.log(JSON.stringify({ ficheiro: err?.code === "ENOENT" ? "ausente" : "ilegível" }));
  process.exit(err?.code === "ENOENT" ? 0 : 2);
}
let state;
try {
  state = JSON.parse(raw);
} catch {
  console.log(JSON.stringify({ ficheiro: "JSON inválido" }));
  process.exit(2);
}
const out = {};
for (const [k, v] of Object.entries(state || {})) {
  if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  else if (Array.isArray(v)) out[`${k}_n`] = v.length;
  else if (v && typeof v === "object") out[`${k}_chaves`] = Object.keys(v).length;
  else if (typeof v === "string" && STATE_KEYS.has(k) && v.length <= 40) out[k] = v;
  else if (v == null) out[k] = null;
  else out[`${k}_presente`] = true;
}
console.log(JSON.stringify(out));
