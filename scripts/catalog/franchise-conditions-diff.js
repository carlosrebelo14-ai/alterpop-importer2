#!/usr/bin/env node
/**
 * ENTREGA 2 · Tarefa 4 — diff das condições versionadas vs as regras REAIS da Shopify.
 * Tarefa 26 (2026-09-11) — a lógica viveu aqui sozinha; agora é
 * lib/importer/shopify/franchiseConditionsGuard.server.js, reutilizada também como
 * portão obrigatório dentro de runApprovedShopifySync (shopifyApprovedSync.server.js),
 * ANTES de qualquer escrita de metafields — não só um script que alguém corre à mão.
 *
 * Comparação por CODE POINT: NÃO normaliza a condição da Shopify antes de comparar.
 * Assinala:
 *   - universo/line ATIVO na tabela sem coleção na loja (dormentes ficam de fora)
 *   - regra PRODUCT_METAFIELD_DEFINITION em falta, com relation/condição errada
 *   - templateSuffix diferente do esperado
 *   - coleção universe-room / line na loja sem entrada na lista versionada
 *   - NBSP / NFD dentro da lista versionada (assertConditionsNFC)
 *
 * DRY / read-only — nunca escreve. Sai != 0 se houver qualquer divergência.
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/franchise-conditions-diff.js
 *   node scripts/catalog/franchise-conditions-diff.js --json
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { computeFranchiseConditionsDiff } from "../../lib/importer/shopify/franchiseConditionsGuard.server.js";
import { FRANCHISE_CONDITIONS } from "../../lib/importer/catalog/franchiseConditions.js";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const { nfcProblems, diffs, stray, collectionsCount } = await computeFranchiseConditionsDiff(client);

  if (JSON_OUT) {
    console.log(JSON.stringify({ shop: SHOP, nfcProblems, diffs, stray: stray.map((c) => c.handle) }, null, 2));
  } else {
    console.log(`=== franchise-conditions-diff (${SHOP}) ===`);
    console.log(`lista versionada: ${FRANCHISE_CONDITIONS.length} entradas · coleções na loja: ${collectionsCount}`);
    if (nfcProblems.length) {
      console.log(`\n⚠️  problemas na lista versionada (corrigir no repo):`);
      for (const p of nfcProblems) console.log(`  - ${p}`);
    }
    if (!diffs.length && !stray.length) {
      console.log(`\n✓ tudo alinhado — pode escrever metafields.`);
    } else {
      for (const d of diffs) {
        console.log(`\n✗ ${d.handle} [${d.kind}] — ${d.problem}`);
        if (d.want != null) {
          console.log(`    versionado: ${JSON.stringify(d.want)}   ${d.wantCps}`);
          console.log(`    shopify   : ${JSON.stringify(d.got)}   ${d.gotCps}`);
        }
      }
      for (const c of stray) {
        console.log(`\n✗ ${c.handle} — coleção ${c.templateSuffix} na loja sem entrada na lista versionada`);
      }
    }
  }

  if (nfcProblems.length || diffs.length || stray.length) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
