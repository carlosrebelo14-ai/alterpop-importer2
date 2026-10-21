#!/usr/bin/env node
/**
 * DBG-16. Despublica na Shopify os publicados que saíram do feed (status DRAFT, nunca apagar).
 *
 * DRY-RUN por defeito: lista os descontinuados, com franquia, formato e data de saída, e não escreve nada.
 * `--execute` despublica. Exige `--ok <referência>`, que é o OK do arquiteto para esta corrida (Decisão 33, ponto 3).
 * Antes de `--execute`, a linha de `docs/execucoes.md` (Decisão 34, ponto 10) tem de estar commitada. O script imprime-a.
 *
 *   node scripts/catalog/descontinuados-despublicar.js --shop <loja>                       # dry-run
 *   node scripts/catalog/descontinuados-despublicar.js --shop <loja> --execute --ok <ref>  # só com OK
 *
 * Recusa-se: sem --ok com --execute, numa loja que não é a configurada (exit 3), e com atividade da app em curso.
 * Reserva a publicação enquanto escreve, para não correr em paralelo com outra publicação.
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { listarDescontinuados } from "../../lib/curation/descontinuados.server.js";
import { recusarSeAtividadeApp, marcarAtividadeApp } from "../../lib/curation/atividadeApp.js";
import { reservarPublicacaoEntreProcessos } from "../../lib/importer/shopify/publicacaoEmCurso.js";
import { despublicarDescontinuadosNaShopify } from "../../lib/importer/shopify/despublicacao.server.js";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
// Um valor nunca é uma flag: `--ok --execute` não conta como referência.
const valor = (nome) => {
  const i = args.indexOf(nome);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};
const SHOP = valor("--shop") || process.env.SHOPIFY_SHOP_URL;
const OK = valor("--ok");
// Os SKU que o arquiteto aprovou no dry-run. Sem esta lista, --execute despublicaria o que a corrida listar.
const SKUS_APROVADOS = valor("--skus");

if (!SHOP) {
  console.error("Falta --shop <loja>.");
  process.exit(2);
}

if (execute) {
  if (!OK) {
    console.error("--execute precisa de --ok <referência ao OK do arquiteto>. Nada foi escrito.");
    process.exit(2);
  }
  const lojaConfigurada = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP;
  if (SHOP !== lojaConfigurada) {
    console.error(`Recusado: --execute só corre na loja configurada (${lojaConfigurada ?? "não definida"}), e o alvo é ${SHOP}. Nada foi escrito.`);
    process.exit(3);
  }
  if (!SKUS_APROVADOS) {
    console.error("--execute precisa de --skus <lista do dry-run aprovado, separada por vírgulas>. Nada foi escrito.");
    process.exit(2);
  }
  recusarSeAtividadeApp("descontinuados-despublicar");
}

const session = await loadOfflineSessionForShop(SHOP);
const client = createShopifyClientFromSession(session);
const lista = await listarDescontinuados({ shop: SHOP, client });

if (lista.abortado) {
  console.error(`Abortado: ${lista.motivo} Nada foi escrito.`);
  process.exit(4);
}

const aprovados = new Set(
  (SKUS_APROVADOS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const foraDaAprovacao = lista.itens.filter((i) => !aprovados.has(i.sku));
if (execute && foraDaAprovacao.length) {
  console.error(
    `Recusado: a lista mudou desde o dry-run aprovado. Fora da aprovação: ${foraDaAprovacao.map((i) => i.sku).join(", ")}. Nada foi escrito.`
  );
  process.exit(2);
}

const itens = lista.itens.filter((i) => i.productId && aprovados.has(i.sku));
const semProduto = lista.itens.length - itens.length;
console.log(`Ausentes do feed agora: ${lista.ausentesAgora}. Descontinuados listados: ${lista.itens.length}. Com produto na Shopify: ${itens.length}.`);
if (semProduto) console.log(`Sem produto na Shopify (não serão despublicados): ${semProduto}.`);
for (const i of itens) {
  const saiu = i.saiuEm ? i.saiuEm.slice(0, 10) : "data desconhecida";
  console.log(`  ${i.sku} | ${i.titulo} | franquia ${i.franquia ?? "?"} | formato ${i.formato ?? "?"} | saiu ${saiu} | ${i.productId}`);
}

if (!execute) {
  console.log(`\nSKU para aprovar, no --skus: ${lista.itens.map((i) => i.sku).join(",") || "(nenhum)"}`);
  console.log("DRY-RUN — nada escrito. Para despublicar: --execute --ok <referência ao OK do arquiteto> --skus <lista acima>.");
  process.exit(0);
}

const comando = `node scripts/catalog/descontinuados-despublicar.js --shop ${SHOP} --execute --ok ${OK} --skus ${[...aprovados].join(",")}`;
console.log("\nLinha para docs/execucoes.md, commitada antes desta corrida (Decisão 34, ponto 10):");
console.log(
  `- ${new Date().toISOString().slice(0, 10)}, despublicação de descontinuados (DBG-16). Comando: \`${comando}\`. ` +
    `Dry-run: ${lista.itens.length} listados, ${itens.length} com produto. OK: ${OK}.`
);

const reserva = await reservarPublicacaoEntreProcessos({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) });
if (!reserva) {
  console.error("Publicação ou reset em curso. Nada foi escrito.");
  process.exit(1);
}

let resultado;
try {
  resultado = await despublicarDescontinuadosNaShopify({ client, itens, aindaTem: reserva.aindaTem });
} finally {
  await reserva.libertar();
}

console.log(`\nDespublicados: ${resultado.ok.length}. Falhas: ${resultado.falhas.length}.`);
for (const f of resultado.falhas) console.error(`  falhou ${f.sku}: ${f.motivo}`);
process.exit(resultado.falhas.length ? 1 : 0);
