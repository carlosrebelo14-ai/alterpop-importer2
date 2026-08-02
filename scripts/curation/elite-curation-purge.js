#!/usr/bin/env node
/**
 * Aplica Curadoria de Elite a todo o catálogo Prisma (remove não conformes).
 *
 * Uso:
 *   node scripts/elite-curation-purge.js
 *   SHOP=alterpop-store.myshopify.com node scripts/elite-curation-purge.js
 */
import "dotenv/config";
import { purgeEliteCatalog, readElitePurgeLog } from "../../lib/importer/curation/eliteCuration.server.js";

const shop = process.env.SHOP || "alterpop-store.myshopify.com";

console.log(`[elite-purge] Loja: ${shop}`);
console.log("[elite-purge] Regras: marcas premium + preço mínimo 15€ net");

const result = await purgeEliteCatalog(shop);

console.log(result.message);
if (Object.keys(result.byReason || {}).length) {
  console.log("[elite-purge] Por motivo:", result.byReason);
}

const log = await readElitePurgeLog(shop);
if (log?.at) {
  console.log(`[elite-purge] Log: ${log.at}`);
}
