#!/usr/bin/env node
/**
 * Tarefa 41 — seletor do lote piloto (5 slots, 8 SKUs).
 *
 * A seleção sai da Prisma na Fly (CatalogProduct + fila de curadoria PENDING), não do
 * Shopify. Determinístico: mesma corrida, mesmos 8 SKUs, desde que a fila/BD não mudem
 * entretanto.
 *
 * Ordem: o piloto CORRE DEPOIS DO WIPE (Decisão 23) — publicar antes gasta o teste em
 * produtos que vão ser apagados. Este script em modo leitura (default) não publica nem
 * altera a fila — é seguro correr antes do wipe só para inspecionar a seleção.
 *
 * READ-ONLY por defeito. `--approve` marca os 8 selecionados como APPROVED na fila de
 * curadoria (bulkSetQueueStatus) — não publica sozinho, isso é o passo 4
 * (runApprovedShopifySync) da sequência.
 *
 * Correr na Fly:
 *   node scripts/pilot-batch-select.js
 *   node scripts/pilot-batch-select.js --approve
 */
import { prisma } from "../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems, bulkSetQueueStatus } from "../lib/curation/curationQueue.server.js";
import { FRANCHISE_UNIVERSES } from "../lib/importer/catalog/franchiseUniverses.js";

const args = process.argv.slice(2);
const APPROVE = args.includes("--approve");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const PAGE = 500;

/** 34 universos ativos — dormentes (Decisão 15/Tarefa 30) excluídos. */
const ACTIVE_UNIVERSE_NAMES = new Set(
  FRANCHISE_UNIVERSES.filter((u) => !u.dormant).map((u) => u.name)
);

/**
 * Predicados por slot, avaliados NESTA ORDEM — um SKU cai no primeiro slot cujo
 * predicado bate, nunca em dois. `resolvedFranchise IS NOT NULL` e "pertence aos 34
 * ativos" já vêm garantidos pelo filtro global, mas os predicados ficam explícitos
 * por fidelidade ao briefing.
 */
const SLOTS = [
  {
    key: "S1",
    target: 2,
    label: "resolvedLine = 'The Mandalorian' AND resolvedFormat IS NOT NULL",
    match: (r) => r.resolvedLine === "The Mandalorian" && r.resolvedFormat != null,
  },
  {
    key: "S2",
    target: 2,
    label: "resolvedFormat = 'Figure' AND resolvedLine IS NULL AND resolvedFranchise IS NOT NULL",
    match: (r) => r.resolvedFormat === "Figure" && r.resolvedLine == null && r.resolvedFranchise != null,
  },
  {
    key: "S3",
    target: 2,
    label: "resolvedFormat IS NULL AND resolvedFranchise IS NOT NULL",
    match: (r) => r.resolvedFormat == null && r.resolvedFranchise != null,
  },
  {
    key: "S4",
    target: 1,
    label: "resolvedFranchise com 2+ valores (crossover por lista)",
    // resolvedFranchise é escalar (String?) na Prisma — nunca há 2+ valores. Fica
    // aqui só para o défice cair no fallback abaixo, como o briefing pede.
    match: () => false,
  },
  {
    key: "S5",
    target: 1,
    label: "cleanTitle IS NOT NULL AND cleanTitle <> title AND resolvedFranchise IS NOT NULL",
    match: (r) => r.cleanTitle != null && r.cleanTitle !== r.title && r.resolvedFranchise != null,
  },
];

async function main() {
  console.log(`=== pilot-batch-select (${SHOP})${APPROVE ? " · --approve" : " · READ-ONLY"} ===\n`);

  const pendingItems = await listCurationQueueItems("PENDING");
  const pendingSkus = new Set(pendingItems.map((i) => i.sku));
  console.log(`fila PENDING: ${pendingSkus.size}`);

  const buckets = Object.fromEntries(SLOTS.map((s) => [s.key, []]));
  let scanned = 0;
  let eligibleAfterGlobalFilters = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: {
        sku: true,
        title: true,
        cleanTitle: true,
        titleOverride: true,
        resolvedFranchise: true,
        resolvedLine: true,
        resolvedFormat: true,
        stock: true,
      },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      scanned += 1;
      if (!pendingSkus.has(r.sku)) continue;
      if (!r.resolvedFranchise || !ACTIVE_UNIVERSE_NAMES.has(r.resolvedFranchise)) continue;
      if (!(r.stock > 0)) continue;
      eligibleAfterGlobalFilters += 1;

      for (const slot of SLOTS) {
        if (slot.match(r)) {
          buckets[slot.key].push(r);
          break; // primeiro slot que bate, nunca dois — ordem S1→S5
        }
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`CatalogProduct analisados: ${scanned}`);
  console.log(`elegíveis após filtros globais (PENDING + universo ativo + stock>0): ${eligibleAfterGlobalFilters}\n`);

  // Défice por slot com os alvos originais.
  const deficits = {};
  for (const slot of SLOTS) deficits[slot.key] = Math.max(0, slot.target - buckets[slot.key].length);

  // Fallback: qualquer défice fora de S2 é compensado subindo o alvo de S2.
  const deficitOutsideS2 = SLOTS.filter((s) => s.key !== "S2").reduce((acc, s) => acc + deficits[s.key], 0);
  const finalTargets = Object.fromEntries(SLOTS.map((s) => [s.key, s.target]));
  for (const slot of SLOTS) {
    if (slot.key === "S2") continue;
    finalTargets[slot.key] = slot.target - deficits[slot.key]; // cai ao que existe
  }
  finalTargets.S2 = Math.min(SLOTS.find((s) => s.key === "S2").target + deficitOutsideS2, buckets.S2.length);

  console.log(`── alvos finais (depois do fallback) ──`);
  for (const slot of SLOTS) {
    const flag = deficits[slot.key] > 0 && slot.key !== "S2" ? "  ← slot caiu, compensado em S2" : "";
    console.log(`  ${slot.key}  alvo original ${slot.target}  ·  candidatos ${buckets[slot.key].length}  ·  alvo final ${finalTargets[slot.key]}${flag}`);
  }
  const totalSelected = SLOTS.reduce((acc, s) => acc + finalTargets[s.key], 0);
  console.log(`\ntotal selecionado: ${totalSelected} (esperado: 8)`);
  if (totalSelected < 8) {
    console.log(`⚠ défice não totalmente compensável — faltam candidatos reais na fila PENDING.`);
  }

  const selected = [];
  for (const slot of SLOTS) {
    const picked = buckets[slot.key].slice(0, finalTargets[slot.key]);
    for (const r of picked) selected.push({ ...r, slot: slot.key });
  }

  console.log(`\n── lote (sku | title | cleanTitle | franchise | line | format | slot) ──`);
  for (const r of selected) {
    console.log(
      `  ${r.sku}\t${(r.title || "").slice(0, 40)}\t${(r.cleanTitle || "∅").slice(0, 40)}\t${r.resolvedFranchise}\t${r.resolvedLine || "∅"}\t${r.resolvedFormat || "∅"}\t${r.slot}`
    );
  }

  if (APPROVE) {
    if (!selected.length) {
      console.log(`\nnada selecionado — nada a aprovar.`);
    } else {
      const skus = selected.map((r) => r.sku);
      const { updatedItems } = await bulkSetQueueStatus(skus, "APPROVED");
      console.log(`\n✓ ${updatedItems.length} SKUs marcados APPROVED na fila de curadoria.`);
    }
  } else {
    console.log(`\nREAD-ONLY — nada escrito na fila. Corre com --approve para marcar APPROVED.`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
