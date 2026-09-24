/**
 * Ciclo de vida do SKU no feed OcioStock — itens 2 e 3 do pacote de melhorias
 * criativas de 2026-08-12 (deteção de novidades / descontinuados).
 *
 * CatalogProduct é limpo e reconstruído em cada ciclo do relógio (ver
 * syncCatalogWithProgress `clearFirst`), por isso não dá para comparar "SKUs deste
 * ciclo" com "SKUs do ciclo anterior" olhando só para essa tabela. CatalogSkuTracking
 * (schema.prisma) é a tabela que sobrevive entre ciclos e guarda esse histórico.
 *
 * Chamado UMA VEZ no fim de cada ciclo completo (não resumido) de indexação —
 * ver indexingStream.server.js. Nunca corre sobre um resume parcial, porque nesse
 * caso o CSV não foi lido do início e "SKU ausente" não significaria nada.
 */
import fs from "fs/promises";
import path from "path";
import { prisma, safePrisma, findManyConfirmed } from "../../prisma/prismaSafe.server.js";
import { loadMarketSettings } from "../curation/dynamicRules.server.js";
import { getDefaultConfig } from "../config.js";

/**
 * Marca que o modo semente já correu uma vez para esta loja. Sem isto, QUALQUER
 * esvaziamento futuro de CatalogSkuTracking (bug, migração falhada, reset manual)
 * voltaria a ser tratado como semente legítima — silencioso outra vez, o mesmo
 * defeito que estamos a corrigir. Depois do primeiro deploy, tracking vazio com
 * catálogo real é anomalia: entra no fluxo normal (não suprime newSkuCount), o que
 * deixa isLifecycleReportSuspect() apanhá-lo sozinho.
 */
function seedMarkerPath(shop) {
  return path.join(getDefaultConfig().paths.data, "sku-tracking-seeded", `${shop.replace(/\//g, "_")}.json`);
}

async function hasSeededBefore(shop) {
  try {
    await fs.access(seedMarkerPath(shop));
    return true;
  } catch {
    return false;
  }
}

async function markSeeded(shop, count) {
  const p = seedMarkerPath(shop);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ shop, seededAt: new Date().toISOString(), count }, null, 2), "utf8");
}

/** Ciclos consecutivos sem aparecer no CSV antes de marcar para revisão (~2h15 a 45min/ciclo). */
export const DISCONTINUED_THRESHOLD = 3;

/** Limite de itens guardados por relatório de ciclo — evita JSON gigante se um feed mudar radicalmente. */
const REPORT_LIST_CAP = 200;

/** Acima disto, newSkuCount fora do modo semente é sinal de leitura quebrada, não novidade real. */
const SUSPECT_NEW_SKU_RATIO = 0.5;

const CHUNK = 300;

/** Lotes do INSERT OR IGNORE em CatalogSkuTracking — nunca o catálogo inteiro numa só query (máquina de 512MB). */
const TRACKING_INSERT_CHUNK = 500;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Grava SKUs novos em CatalogSkuTracking em lotes de 500, dentro de uma única
 * transação. Nunca usa `createMany({ skipDuplicates: true })` — o Prisma não
 * suporta `skipDuplicates` em SQLite (lança sempre) e, ao lançar sobre um `data`
 * com milhares de linhas, despeja o array inteiro formatado na mensagem de erro.
 * Isso pousa no processo principal ao mesmo tempo que o worker de indexação está
 * no pico de memória — dois picos a coincidir (ver medição de RSS 24/09, servidor
 * 106MB→236MB no instante exato do crash do createMany). Erro em SQL bruto não
 * carrega o payload de volta.
 * @param {string} shop
 * @param {{sku: string, vendor?: string|null, franchises?: string}[]} rows
 * @param {Date} now
 * @returns {Promise<number>} total de linhas afetadas (soma dos INSERT OR IGNORE)
 */
async function insertTrackedSkusBatched(shop, rows, now) {
  const chunks = chunkArray(rows, TRACKING_INSERT_CHUNK);
  let totalAffected = 0;
  await prisma.$transaction(async (tx) => {
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, 0, 'active')").join(", ");
      const params = chunk.flatMap((r) => [
        shop,
        r.sku,
        r.vendor || null,
        r.franchises || "[]",
        now.toISOString(),
        now.toISOString(),
      ]);
      const affected = await tx.$executeRawUnsafe(
        `INSERT OR IGNORE INTO CatalogSkuTracking
         (shop, sku, vendor, franchises, firstSeenAt, lastSeenAt, missingCycles, status)
         VALUES ${placeholders}`,
        ...params
      );
      totalAffected += Number(affected) || 0;
    }
  });
  return totalAffected;
}

/**
 * Sinal para o portão de saúde: um ciclo normal (não-semente) que reporta mais de
 * metade do catálogo como "novo" não encontrou novidade real — encontrou uma
 * leitura de CatalogSkuTracking quebrada (repete o incidente de 24/09: tabela
 * vazia há 43 dias, todo o catálogo lido como novo em todos os ciclos).
 * @param {{ newSkuCount: number, catalogSize: number, isSeedRun: boolean }} args
 */
export function isLifecycleReportSuspect({ newSkuCount, catalogSize, isSeedRun }) {
  if (isSeedRun) return false;
  if (!catalogSize || catalogSize <= 0) return false;
  return newSkuCount / catalogSize > SUSPECT_NEW_SKU_RATIO;
}

function parseFranchises(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * @param {{ vendor?: string|null, franchises?: string }} product franchises is the raw JSON-encoded column value
 * @param {{ vipBrands: string[], vipLicences: string[] }} vipConfig
 */
function isVip(product, vipConfig) {
  const vendorLower = String(product.vendor || "").toLowerCase();
  if (vipConfig.vipBrands.some((b) => vendorLower.includes(b.toLowerCase()))) return true;
  const franchisesLower = parseFranchises(product.franchises).map((f) => String(f).toLowerCase());
  return vipConfig.vipLicences.some((lic) =>
    franchisesLower.some((f) => f.includes(lic.toLowerCase()))
  );
}

/**
 * Corre a comparação de ciclo — chamar depois de um `syncCatalogWithProgress` completo
 * e não-resumido. Nunca lança: falhas aqui não devem impedir o publish do ciclo.
 * @param {string} shop
 */
export async function runSkuLifecycleCycle(shop) {
  try {
    // Briefing "Leitura confirmada" (Decisão 30) — eram safePrisma com fallback:[],
    // rethrow:false: uma falha de leitura aqui virava "SKU não rastreado" e GRAVAVA
    // essa mentira em CatalogSkuTracking (estado persistente — não sobrevive só ao
    // processo, sobrevive ao próximo ciclo também). Censado como BLOCKING em
    // docs/db-read-safety-census.md, o mais grave dos dois porque a corrupção não se
    // limita à resposta pontual. Agora lança — o catch já existente (abaixo) apanha,
    // regista a nível de erro, e devolve sem tocar em nenhuma escrita: as mutações
    // (createMany/UPDATE em lote) ficam todas depois destas duas leituras, nunca
    // correm se qualquer uma falhar ou for inconsistente.
    const [currentRows, trackingRows] = await Promise.all([
      findManyConfirmed(prisma.catalogProduct, {
        where: { shop },
        select: { sku: true, vendor: true, franchises: true },
      }),
      findManyConfirmed(prisma.catalogSkuTracking, {
        where: { shop },
        select: { sku: true, status: true, missingCycles: true },
      }),
    ]);

    const currentBySku = new Map(currentRows.map((r) => [r.sku, r]));
    const trackedSkus = new Set(trackingRows.map((r) => r.sku));

    const newSkus = currentRows.filter((r) => !trackedSkus.has(r.sku));
    const stillPresentSkus = trackingRows.filter((r) => currentBySku.has(r.sku)).map((r) => r.sku);
    const missingRows = trackingRows.filter((r) => !currentBySku.has(r.sku));

    // Modo semente: tracking vazio, catálogo real presente, E ainda não semeámos
    // esta loja desde o fix. Só dispara UMA VEZ por loja — marcado em disco (ver
    // seedMarkerPath). Tracking vazio DEPOIS de já ter semeado é anomalia (bug,
    // migração falhada, reset manual), não semente: cai no fluxo normal, reporta
    // newSkuCount a sério, e isLifecycleReportSuspect() apanha-o sozinho como
    // vermelho — exatamente para não repetir "tabela vazia tratada como normal em
    // silêncio", o defeito de 43 dias que este fix corrige.
    const alreadySeeded = await hasSeededBefore(shop);
    const isSeedRun = trackedSkus.size === 0 && currentRows.length > 0 && !alreadySeeded;

    const vipConfig = loadMarketSettings(shop);
    const now = new Date();

    // Novos SKUs — lotes de 500 dentro de transação, nunca createMany com
    // skipDuplicates (não suportado em SQLite, ver insertTrackedSkusBatched).
    // rethrow:true — uma escrita que falha aqui tem de abortar o ciclo (apanhado
    // pelo catch geral desta função) em vez de gravar um relatório que promete um
    // estado que a tabela não tem.
    if (newSkus.length) {
      const inserted = await safePrisma(
        "skuLifecycle.insertNew",
        () => insertTrackedSkusBatched(shop, newSkus, now),
        { rethrow: true }
      );
      if (inserted !== newSkus.length) {
        throw new Error(
          `skuLifecycle.insertNew: processadas ${inserted} de ${newSkus.length} — não bateram certo`
        );
      }
      if (isSeedRun) {
        await markSeeded(shop, inserted);
        console.log(
          `[skuLifecycle] MODO SEMENTE (${shop}): ${inserted} SKUs gravados como linha de base em CatalogSkuTracking, sem novidade reportada. Marcado em disco — não volta a disparar para esta loja.`
        );
      } else if (trackedSkus.size === 0 && currentRows.length > 0) {
        console.error(
          `[skuLifecycle] ANOMALIA (${shop}): CatalogSkuTracking está vazia outra vez, mas já tinha sido semeada. ${inserted} SKUs gravados como "novos" a sério — não é semente.`
        );
      }
    }

    // SKUs que continuam a aparecer — reset de missingCycles, sai de "review" se lá estava.
    for (const chunk of chunkArray(stillPresentSkus, CHUNK)) {
      await safePrisma("skuLifecycle.touchPresent", () =>
        prisma.$executeRawUnsafe(
          `UPDATE CatalogSkuTracking
           SET lastSeenAt = ?, missingCycles = 0,
               status = CASE WHEN status = 'review' THEN 'active' ELSE status END,
               vendor = COALESCE((SELECT vendor FROM CatalogProduct WHERE CatalogProduct.shop = CatalogSkuTracking.shop AND CatalogProduct.sku = CatalogSkuTracking.sku), vendor)
           WHERE shop = ? AND sku IN (${chunk.map(() => "?").join(",")})`,
          now.toISOString(),
          shop,
          ...chunk
        )
      );
    }

    // SKUs ausentes deste ciclo — incrementa contador, marca para revisão ao 3.º ciclo seguido.
    const missingSkus = missingRows.map((r) => r.sku);
    for (const chunk of chunkArray(missingSkus, CHUNK)) {
      await safePrisma("skuLifecycle.touchMissing", () =>
        prisma.$executeRawUnsafe(
          `UPDATE CatalogSkuTracking
           SET missingCycles = missingCycles + 1,
               status = CASE WHEN missingCycles + 1 >= ? THEN 'review' ELSE status END
           WHERE shop = ? AND sku IN (${chunk.map(() => "?").join(",")})`,
          DISCONTINUED_THRESHOLD,
          shop,
          ...chunk
        )
      );
    }

    const newVipSkus = isSeedRun
      ? []
      : newSkus
          .filter((r) => isVip(r, vipConfig))
          .slice(0, REPORT_LIST_CAP)
          .map((r) => ({ sku: r.sku, vendor: r.vendor || null, franchises: parseFranchises(r.franchises) }));

    const newlyReviewRows = missingRows.filter((r) => (r.missingCycles || 0) + 1 >= DISCONTINUED_THRESHOLD);
    const discontinuedReviewList = newlyReviewRows.slice(0, REPORT_LIST_CAP).map((r) => ({
      sku: r.sku,
      missingCycles: (r.missingCycles || 0) + 1,
    }));

    const reportedNewSkuCount = isSeedRun ? 0 : newSkus.length;

    if (isLifecycleReportSuspect({ newSkuCount: reportedNewSkuCount, catalogSize: currentRows.length, isSeedRun })) {
      console.error(
        `[skuLifecycle] SUSPEITO (${shop}): ${reportedNewSkuCount} novos de ${currentRows.length} no catálogo ` +
          `(> ${SUSPECT_NEW_SKU_RATIO * 100}%) fora do modo semente — provável leitura de CatalogSkuTracking quebrada, não novidade real.`
      );
    }

    const report = await safePrisma("skuLifecycle.saveReport", () =>
      prisma.skuLifecycleCycleReport.create({
        data: {
          shop,
          ranAt: now,
          newSkuCount: reportedNewSkuCount,
          newVipSkusJson: JSON.stringify(newVipSkus),
          discontinuedReviewCount: newlyReviewRows.length,
          discontinuedReviewJson: JSON.stringify(discontinuedReviewList),
        },
      })
    );

    await pruneOldLifecycleReports(shop);

    console.log(
      `[skuLifecycle] ${shop}: ${reportedNewSkuCount} novos SKUs (${newVipSkus.length} VIP)${isSeedRun ? " [modo semente]" : ""}, ` +
        `${newlyReviewRows.length} passaram a "para revisão" (${DISCONTINUED_THRESHOLD}+ ciclos ausentes).`
    );

    return report;
  } catch (err) {
    console.error("[skuLifecycle] ciclo falhou (não fatal):", err?.message || err);
    return null;
  }
}

/** Quantos relatórios de ciclo manter por loja (~1 a cada 45min → ~500 ≈ 2 semanas). */
const LIFECYCLE_REPORT_RETENTION = 500;

/**
 * Poda (code review 2026-08-13) — sem isto, SkuLifecycleCycleReport crescia sem
 * limite para sempre, uma linha por ciclo do relógio. Mantém histórico suficiente
 * para tendência sem crescer indefinidamente.
 * @param {string} shop
 */
async function pruneOldLifecycleReports(shop) {
  const keepRows = await safePrisma(
    "skuLifecycle.pruneKeepIds",
    () =>
      prisma.skuLifecycleCycleReport.findMany({
        where: { shop },
        orderBy: { ranAt: "desc" },
        take: 1,
        skip: LIFECYCLE_REPORT_RETENTION - 1,
        select: { ranAt: true },
      }),
    { rethrow: false, fallback: [] }
  );
  const cutoff = keepRows[0]?.ranAt;
  if (!cutoff) return; // menos de LIFECYCLE_REPORT_RETENTION relatórios — nada a podar
  await safePrisma("skuLifecycle.prune", () =>
    prisma.skuLifecycleCycleReport.deleteMany({
      where: { shop, ranAt: { lt: cutoff } },
    })
  );
}

/** @param {string} shop */
export async function getLatestLifecycleReport(shop) {
  const row = await safePrisma("skuLifecycle.latest", () =>
    prisma.skuLifecycleCycleReport.findFirst({
      where: { shop },
      orderBy: { ranAt: "desc" },
    }),
    { rethrow: false, fallback: null }
  );
  if (!row) return null;
  return {
    ranAt: row.ranAt,
    newSkuCount: row.newSkuCount,
    newVipSkus: JSON.parse(row.newVipSkusJson || "[]"),
    discontinuedReviewCount: row.discontinuedReviewCount,
    discontinuedReview: JSON.parse(row.discontinuedReviewJson || "[]"),
  };
}

/** Todos os SKUs atualmente marcados "para revisão" (não só os do último ciclo) — para Relatórios. */
export async function listSkusForReview(shop) {
  const rows = await safePrisma("skuLifecycle.listReview", () =>
    prisma.catalogSkuTracking.findMany({
      where: { shop, status: "review" },
      orderBy: { lastSeenAt: "asc" },
      take: 500,
    }),
    { rethrow: false, fallback: [] }
  );
  return rows.map((r) => ({
    sku: r.sku,
    vendor: r.vendor,
    missingCycles: r.missingCycles,
    lastSeenAt: r.lastSeenAt,
  }));
}
