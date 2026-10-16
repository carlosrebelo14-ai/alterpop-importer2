#!/usr/bin/env node
/**
 * Aplica Curadoria de Elite a todo o catálogo Prisma (remove não conformes).
 *
 * BLOQUEADA até ao PR 2b-2 (DBG-43). Decisão 5 do arquiteto: a purga de elite fica proibida em
 * produção. O script sai com código 1 antes de carregar módulos, de ler ou de escrever, também em
 * dry-run. purgeEliteCatalog continua em lib/importer/curation/eliteCuration.server.js, porque o
 * PR 2b-2 a usa. No PR 2b-2 retira-se o bloqueio marcado abaixo.
 *
 * Uso (depois do PR 2b-2):
 *   node scripts/elite-curation-purge.js
 *   SHOP=alterpop-store.myshopify.com node scripts/elite-curation-purge.js
 */

// BLOQUEIO (DBG-43, PR 2b-2). Retirar estas duas instruções ao reativar a purga.
console.error(
  "[elite-purge] Recusado. A purga de elite está bloqueada até DBG-43, PR 2b-2. " +
    "Não corre em produção até lá. Nada foi lido nem gravado."
);
process.exit(1);

// Imports dinâmicos de propósito: nada é carregado (nem o .env, nem o Prisma) antes da recusa.
await import("dotenv/config");
const { purgeEliteCatalog, readElitePurgeLog } = await import(
  "../../lib/importer/curation/eliteCuration.server.js"
);
const { recusarSeAtividadeApp } = await import("../../lib/curation/atividadeApp.js");

const shop = process.env.SHOP || "alterpop-store.myshopify.com";

console.log(`[elite-purge] Loja: ${shop}`);
console.log("[elite-purge] Regras: marcas premium + preço mínimo 15€ net");

recusarSeAtividadeApp("elite-curation-purge");
const result = await purgeEliteCatalog(shop);

console.log(result.message);
if (Object.keys(result.byReason || {}).length) {
  console.log("[elite-purge] Por motivo:", result.byReason);
}

const log = await readElitePurgeLog(shop);
if (log?.at) {
  console.log(`[elite-purge] Log: ${log.at}`);
}
