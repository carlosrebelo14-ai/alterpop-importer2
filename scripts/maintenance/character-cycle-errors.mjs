/* eslint-env node */
/**
 * Erros de escrita do último ciclo das páginas de Character, sem handles nem GIDs. Só lê.
 * Enviado para a Fly em base64 pelo scripts/ci/maintenance.sh (não precisa de deploy), corre em /app:
 *   echo <base64> | base64 -d | node --input-type=module -
 *
 * Mantém o texto de validação da Shopify (ex.: "Products can't be blank") e tira o que identifica
 * produtos: o que está entre parênteses (handle, GID) e qualquer gid://. Imprime linhas "ERRO: ...".
 */
import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "data", "character-pages-cycle-state.json");
let state;
try {
  state = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  console.log(`ERRO: estado ilegível (${err?.code === "ENOENT" ? "ficheiro ausente" : "JSON inválido"})`);
  process.exit(0);
}
const clean = (m) =>
  String(m ?? "")
    .replace(/gid:\/\/\S+/g, "gid")
    .replace(/\([^)]*\)/g, "(…)")
    .replace(/\s+/g, " ")
    .slice(0, 240);
for (const e of state.writeErrors || []) console.log(`ERRO: escrita: ${clean(e?.message ?? e)}`);
for (const e of state.invalid || []) console.log(`ERRO: plano inválido: ${clean(e?.error)}`);
if (!(state.writeErrors || []).length && !(state.invalid || []).length) console.log("ERRO: nenhum");
