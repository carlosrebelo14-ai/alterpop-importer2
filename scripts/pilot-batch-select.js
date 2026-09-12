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
 * Tarefa 42 (2026-09-12) — F1–F4, aplicados antes da distribuição por slot e antes da
 * ordenação sku ASC:
 *   F1  sku só numérico, 8/12/13/14 dígitos — exclui concatenações de ruído do feed
 *   F2  título sem tokens de sortido cego (assorted/mystery/blind/surprise/random)
 *   F3  sem contradição título/ref (mesma regra da Tarefa 11, recalculada aqui)
 *   F4  ordenação sku ASC, aplicada só ao conjunto já filtrado por F1–F3
 *
 * Tarefa 44 (2026-09-12) — `--exclude <sku>` (repetível, ou lista separada por
 * vírgulas) tira SKUs específicos da corrida sem tocar em código. Usado quando a
 * revisão manual do Carlos apanha um falso positivo do resolver que os filtros F1–F3
 * não cobrem.
 *
 * Tarefa 46 (2026-09-12) — F5, teto de 2 SKUs por `resolvedFranchise` no lote
 * inteiro. A v3 do lote saiu com 3/8 em Super Mario — vitrine pré-inaugural
 * desequilibrada, só 5 universos exercitados em vez de 7. Avaliado na MESMA ordem de
 * prioridade S1→S5 usada para atribuir slot: o primeiro SKU de um universo a chegar
 * (nessa ordem, sku ASC dentro de cada slot) fica; o resto desse universo é saltado —
 * "recua para o universo seguinte em sku ASC" dentro do mesmo slot. Os défices de
 * S1/S3/S4/S5 continuam a compensar-se subindo o alvo de S2 (Tarefa 41/42), agora
 * também sujeito ao teto: a compensação continua a consumir o bucket de S2 a partir
 * de onde a seleção base parou, nunca reinicia do zero (evita contar o mesmo SKU 2×).
 *
 * Correr na Fly:
 *   node scripts/pilot-batch-select.js
 *   node scripts/pilot-batch-select.js --exclude 0035051531166,0039897585413
 *   node scripts/pilot-batch-select.js --approve
 */
import { prisma } from "../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems, bulkSetQueueStatus } from "../lib/curation/curationQueue.server.js";
import { FRANCHISE_UNIVERSES } from "../lib/importer/catalog/franchiseUniverses.js";
import { FRANCHISE_LINES } from "../lib/importer/catalog/franchiseLines.js";
import { titleOnlyUniverse } from "../lib/importer/catalog/franchiseResolver.server.js";

const args = process.argv.slice(2);
const APPROVE = args.includes("--approve");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const PAGE = 500;
const EXCLUDED_SKUS = new Set(
  args
    .reduce((acc, a, i) => {
      if (a === "--exclude" && args[i + 1]) acc.push(args[i + 1]);
      return acc;
    }, [])
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter(Boolean)
);
const UNIVERSE_CAP = 2; // Tarefa 46 (F5) — máximo de SKUs por resolvedFranchise no lote inteiro

/** 34 universos ativos — dormentes (Decisão 15/Tarefa 30) excluídos. */
const ACTIVE_UNIVERSE_NAMES = new Set(
  FRANCHISE_UNIVERSES.filter((u) => !u.dormant).map((u) => u.name)
);

const HANDLE_BY_NAME = new Map(FRANCHISE_UNIVERSES.map((u) => [u.name, u.handle]));
const LINE_BY_NAME = new Map(FRANCHISE_LINES.map((l) => [l.line, l]));

/**
 * Tarefa 42 — filtros F1–F4, aplicados ANTES da distribuição por slot. O seletor
 * original (Tarefa 41) só olhava para franchise/line/format resolvidos; a revisão do
 * Carlos apanhou 3 SKUs malformados (concatenações de ruído do fornecedor, fora de
 * EAN-13/UPC-12) e 4 produtos de sortido cego (assorted/mystery/blind/surprise) —
 * escolha errada para o lote pré-inaugural, que agora é permanente na loja
 * (Decisão 23).
 */

/** F1 — sku só numérico, 8/12/13/14 dígitos (EAN-8, UPC-12, EAN-13, EAN/ITF-14). */
const SKU_SHAPE_RE = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/;
function passesSkuShape(sku) {
  return SKU_SHAPE_RE.test(String(sku || ""));
}

/** F2 — título sem tokens de sortido cego. Case-insensitive, palavra inteira. */
const BLIND_TOKEN_RE = /\b(assorted|mystery|blind|surprise|random)\b/i;
function passesNoBlindTokens(row) {
  const haystack = `${row.title || ""} ${row.cleanTitle || ""}`;
  return !BLIND_TOKEN_RE.test(haystack);
}

/**
 * F3 — exclui contradição título/ref (mesma lógica da Tarefa 11,
 * franchise-title-ref-contradiction.js, recalculada aqui em vez de ler uma lista
 * estática para nunca desalinhar do resolver atual).
 */
function hasTitleRefContradiction(row) {
  if (row.resolvedFranchiseLayer !== 1) return false; // só camada 1 (ref) pode contradizer
  const titleHit = titleOnlyUniverse({ title: row.title, titleSource: row.titleSource }, {});
  if (!titleHit) return false;

  const refHandle = HANDLE_BY_NAME.get(row.resolvedFranchise) || null;
  if (!refHandle || titleHit.handle === refHandle) return false;

  if (row.resolvedLine) {
    const line = LINE_BY_NAME.get(row.resolvedLine);
    const parentHandle = line ? HANDLE_BY_NAME.get(line.parent) : null;
    if (parentHandle && parentHandle === titleHit.handle) return false; // Line já reconcilia
  }
  return true;
}

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
  if (EXCLUDED_SKUS.size) console.log(`excluídos manualmente (--exclude): ${[...EXCLUDED_SKUS].join(", ")}`);

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
        titleSource: true,
        resolvedFranchise: true,
        resolvedFranchiseLayer: true,
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
      if (EXCLUDED_SKUS.has(r.sku)) continue; // Tarefa 44 — exclusão manual pontual
      if (!r.resolvedFranchise || !ACTIVE_UNIVERSE_NAMES.has(r.resolvedFranchise)) continue;
      if (!(r.stock > 0)) continue;
      if (!passesSkuShape(r.sku)) continue; // F1
      if (!passesNoBlindTokens(r)) continue; // F2
      if (hasTitleRefContradiction(r)) continue; // F3
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
  console.log(
    `elegíveis após filtros globais (PENDING + universo ativo + stock>0 + F1 sku válido + F2 sem tokens blind + F3 sem contradição título/ref): ${eligibleAfterGlobalFilters}\n`
  );

  // Tarefa 46 (F5) — seleção com teto por universo, na ordem de prioridade S1→S5.
  // Percorre cada bucket com um ponteiro próprio (não reinicia do zero), salta
  // candidatos cujo universo já bateu no teto ("recua para o universo seguinte em
  // sku ASC"), e devolve quantos conseguiu apanhar — o défice fica visível já aqui.
  const universeCounts = new Map();
  const bucketIndex = Object.fromEntries(SLOTS.map((s) => [s.key, 0]));
  const pickedBySlot = Object.fromEntries(SLOTS.map((s) => [s.key, []]));

  function pickMore(slotKey, wantMore) {
    const bucket = buckets[slotKey];
    const out = [];
    let i = bucketIndex[slotKey];
    while (out.length < wantMore && i < bucket.length) {
      const r = bucket[i];
      i += 1;
      const u = r.resolvedFranchise;
      if ((universeCounts.get(u) || 0) >= UNIVERSE_CAP) continue; // F5 — salta, próximo sku ASC
      universeCounts.set(u, (universeCounts.get(u) || 0) + 1);
      out.push(r);
    }
    bucketIndex[slotKey] = i;
    pickedBySlot[slotKey].push(...out);
    return out;
  }

  const deficits = {};
  for (const slot of SLOTS) {
    pickMore(slot.key, slot.target);
    deficits[slot.key] = slot.target - pickedBySlot[slot.key].length;
  }

  // Fallback: qualquer défice fora de S2 (incl. o do próprio F5) é compensado
  // subindo o alvo de S2 — continuando o MESMO bucket de S2 a partir de onde a
  // seleção base parou, nunca do zero.
  const deficitOutsideS2 = SLOTS.filter((s) => s.key !== "S2").reduce((acc, s) => acc + Math.max(0, deficits[s.key]), 0);
  if (deficitOutsideS2 > 0) {
    pickMore("S2", deficitOutsideS2);
  }

  console.log(`── alvos finais (depois do fallback + teto F5 de ${UNIVERSE_CAP}/universo) ──`);
  for (const slot of SLOTS) {
    const actual = pickedBySlot[slot.key].length;
    const flag = deficits[slot.key] > 0 && slot.key !== "S2" ? "  ← slot caiu, compensado em S2" : "";
    console.log(`  ${slot.key}  alvo original ${slot.target}  ·  candidatos ${buckets[slot.key].length}  ·  selecionados ${actual}${flag}`);
  }
  const totalSelected = SLOTS.reduce((acc, s) => acc + pickedBySlot[s.key].length, 0);
  console.log(`\ntotal selecionado: ${totalSelected} (esperado: 8)`);
  if (totalSelected < 8) {
    console.log(`⚠ défice não totalmente compensável — faltam candidatos reais na fila PENDING (ou o teto F5 esgotou o bucket).`);
  }

  console.log(`\n── distribuição por universo ──`);
  for (const [u, c] of [...universeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(2)}  ${u}`);
  }

  const selected = [];
  for (const slot of SLOTS) {
    for (const r of pickedBySlot[slot.key]) selected.push({ ...r, slot: slot.key });
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
