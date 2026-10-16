#!/usr/bin/env node
/**
 * Curadoria de Elite sobre o catálogo Prisma (DBG-43).
 *
 * Por omissão é um dry-run: lê o catálogo e a fila, mostra o que sairia e o que ficaria retido, e
 * não escreve nada. A escrita (`--execute`) está bloqueada até OK do arquiteto: o script sai com
 * código 1 antes de carregar módulos, de ler ou de escrever.
 *
 * Uso:
 *   node scripts/curation/elite-curation-purge.js
 *   SHOP=alterpop-store.myshopify.com node scripts/curation/elite-curation-purge.js
 */

if (process.argv.slice(2).includes("--execute")) {
  console.error(
    "[elite-purge] Recusado. A purga com escrita (--execute) está bloqueada até OK do arquiteto (DBG-43). " +
      "Nada foi lido nem gravado."
  );
  process.exit(1);
}

// Imports dinâmicos de propósito: o .env e o Prisma só carregam depois da recusa acima.
await import("dotenv/config");
const { purgeEliteCatalog } = await import("../../lib/importer/curation/eliteCuration.server.js");
const { recusarSeAtividadeApp } = await import("../../lib/curation/atividadeApp.js");

const shop = process.env.SHOP || "alterpop-store.myshopify.com";

console.log(`[elite-purge] Loja: ${shop}`);
console.log("[elite-purge] Dry-run: nada é escrito.");

recusarSeAtividadeApp("elite-curation-purge");
const resultado = await purgeEliteCatalog(shop, { executar: false });

console.log(resultado.message);
if (Object.keys(resultado.byReason || {}).length) {
  console.log("[elite-purge] Sairiam por motivo:", resultado.byReason);
}
if (Object.keys(resultado.retidosPorMotivo || {}).length) {
  console.log("[elite-purge] Retidos por motivo:", resultado.retidosPorMotivo);
}
