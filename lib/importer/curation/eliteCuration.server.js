import fs from "fs/promises";
import path from "path";
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { getDefaultConfig } from "../config.js";
import { loadCuration, normalizeForMatch, clearCurationCache } from "./loadCuration.js";
import { evaluateStructuredCatalogFilter } from "./structuredCatalogFilter.server.js";
import { catalogRowToEvaluateRecord } from "../catalog/purgeDatabase.server.js";
import { getCatalogProductTotal } from "../catalog/catalogProductsDb.server.js";

const SCAN_BATCH = 500;
const DELETE_BATCH = 200;

/**
 * Marca premium (match parcial no vendor).
 * @param {import('../types.js').ProductRecord} record
 * @param {ReturnType<typeof loadCuration>} rules
 */
export function isPremiumBrand(record, rules) {
  const vendor = normalizeForMatch(record.vendor);
  if (!vendor) return false;

  for (const brandNorm of rules.premiumBrandsNorm) {
    if (!brandNorm) continue;
    const brandAscii = brandNorm.normalize("NFD").replace(/\p{M}/gu, "");
    const vendorAscii = vendor.normalize("NFD").replace(/\p{M}/gu, "");
    if (
      vendor === brandNorm ||
      vendor.includes(brandNorm) ||
      brandNorm.includes(vendor) ||
      vendorAscii.includes(brandAscii) ||
      brandAscii.includes(vendorAscii)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Curadoria de Elite — precedência sobre smart rules e IA (nunca auto-aprova fora da lista).
 * @param {import('../types.js').ProductRecord} record
 * @returns {{ action: 'AUTO_REJECT' | 'PENDING_MANUAL' | null, reasons: string[] }}
 */
export function evaluateEliteCuration(record) {
  const structured = evaluateStructuredCatalogFilter(record);
  if (structured.fastTrack) {
    return { action: null, reasons: [structured.reason || "structured_fast_track"] };
  }

  if (structured.excluded) {
    return {
      action: "AUTO_REJECT",
      reasons: [structured.reason || "structured_reject"],
    };
  }

  const rules = loadCuration();
  if (!isPremiumBrand(record, rules)) {
    return {
      action: "PENDING_MANUAL",
      reasons: ["elite_brand_not_premium"],
    };
  }

  return { action: null, reasons: [] };
}

/**
 * Produto deve sair do catálogo na limpeza elite.
 * @param {import('../types.js').ProductRecord} record
 */
export function shouldPurgeEliteProduct(record) {
  const elite = evaluateEliteCuration(record);
  return elite.action === "AUTO_REJECT" || elite.action === "PENDING_MANUAL";
}

function elitePurgeLogPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}-elite-purge-log.json`
  );
}

/**
 * DBG-43. Decide se uma entrada da fila pode sair pela curadoria de elite. Só sai o que não tem
 * decisão humana: PENDING, ou origem regra/elite. Ficam como estão, com motivo: publicado ou com
 * erro de sincronização, marca de apagado no admin, decisão humana, origem reset (fixado pelo reset,
 * Decisão 5) e SKU sem entrada na fila (fail closed).
 * @param {{ status?: string, metadata?: Record<string, any> } | null | undefined} item
 * @returns {{ pode: boolean, motivo: string | null }}
 */
export function avaliarPurgaDeEntrada(item) {
  if (!item) return { pode: false, motivo: "sem_entrada" };
  const meta = item.metadata || {};
  if (item.status === "PUBLISHED" || item.status === "SYNC_ERROR" || meta.shopifyProductId) {
    return { pode: false, motivo: "publicado_ou_erro" };
  }
  if (meta.deletedInAdmin) return { pode: false, motivo: "apagado_no_admin" };
  if (meta.origem === "humano") return { pode: false, motivo: "decisao_humana" };
  if (meta.origem === "reset") return { pode: false, motivo: "reset" };
  if (item.status === "PENDING" || meta.origem === "regra" || meta.origem === "elite") {
    return { pode: true, motivo: null };
  }
  return { pode: false, motivo: "sem_origem" };
}

/**
 * Aplica a purga à fila dada. A decisão de elite vem da leitura do catálogo (acoesPorSku, SKU → ação e
 * motivo), que tem a linha completa. Não se reavalia a fila com registos parciais: sem a categoria, a
 * regra daria outro resultado e a fila e o catálogo ficariam em desacordo. Só mexe nas entradas que
 * avaliarPurgaDeEntrada aceita. Uma entrada REJECTED fica como está, mas o SKU pode sair do catálogo.
 * Devolve quantas entradas mudaram e os SKU cuja decisão ainda permite sair do catálogo.
 * @param {{ items: any[] }} fila
 * @param {string} shop
 * @param {Map<string, { action: string, reason: string }>} acoesPorSku
 * @returns {{ alteradas: number, podemSairDoCatalogo: Set<string> }}
 */
export function aplicarPurgaNaFila(fila, shop, acoesPorSku) {
  let alteradas = 0;
  const podemSairDoCatalogo = new Set();
  for (const item of fila.items) {
    const acao = acoesPorSku.get(item.sku);
    if (!acao || !avaliarPurgaDeEntrada(item).pode) continue;
    podemSairDoCatalogo.add(item.sku);
    if (item.status === "REJECTED") continue;

    item.status = acao.action === "AUTO_REJECT" ? "REJECTED" : "PENDING";
    item.shopifyStatus = "DRAFT";
    item.reason = acao.reason;
    item.metadata = {
      ...item.metadata,
      eliteCuration: true,
      eliteAction: acao.action,
      rejectedAt: acao.action === "AUTO_REJECT" ? new Date().toISOString() : item.metadata?.rejectedAt,
      lastElitePurgeAt: new Date().toISOString(),
      shop,
    };
    alteradas += 1;
  }
  return { alteradas, podemSairDoCatalogo };
}

/**
 * Acesso à BD, à fila e ao log. Os testes trocam estas funções por falsas (dependencias).
 */
const DEPENDENCIAS = {
  limparCache: () => clearCurationCache(),
  contarCatalogo: (shop) => getCatalogProductTotal(shop),
  lerLote: ({ shop, cursor }) =>
    safePrisma(
      "catalogProduct.findMany.elitePurge",
      () =>
        prisma.catalogProduct.findMany({
          where: { shop, ...(cursor ? { sku: { gt: cursor } } : {}) },
          take: SCAN_BATCH,
          orderBy: { sku: "asc" },
        }),
      { fallback: [] }
    ),
  apagarLote: ({ shop, skus }) =>
    safePrisma("catalog.elitePurge.delete", () =>
      prisma.$transaction([
        prisma.catalogProductFilterTag.deleteMany({ where: { shop, sku: { in: skus } } }),
        prisma.catalogProduct.deleteMany({ where: { shop, sku: { in: skus } } }),
      ])
    ),
  lerFila: async () => (await import("../../curation/curationQueue.server.js")).loadCurationQueue(),
  mutarFila: async (fn) => (await import("../../curation/curationQueue.server.js")).mutateCurationQueue(fn),
  escreverLog: async (shop, payload) => {
    await fs.mkdir(path.dirname(elitePurgeLogPath(shop)), { recursive: true });
    await fs.writeFile(elitePurgeLogPath(shop), JSON.stringify(payload, null, 2));
  },
};

/** @param {Record<string, number>} porMotivo */
function somar(porMotivo) {
  return Object.values(porMotivo).reduce((total, n) => total + n, 0);
}

/**
 * Curadoria de Elite sobre o catálogo, com a decisão da fila (DBG-43).
 *
 * Sem `executar` é um dry-run: lê o catálogo e a fila, devolve o resumo e não escreve nada. Com
 * `executar`, a ordem é: 1) a fila é escrita primeiro, sob o lock, e cada entrada é avaliada de novo
 * ali; 2) só saem do catálogo os SKU que continuam elegíveis; 3) por fim o log. Se a fila falhar,
 * nada sai do catálogo. A rota da app e a CLI recusam `executar` até OK do arquiteto.
 *
 * @param {string} shop
 * @param {{ executar?: boolean, dependencias?: Partial<typeof DEPENDENCIAS> }} [opcoes]
 */
export async function purgeEliteCatalog(shop, opcoes = {}) {
  const executar = opcoes.executar === true;
  const dep = { ...DEPENDENCIAS, ...(opcoes.dependencias || {}) };
  if (executar) dep.limparCache();

  const before = await dep.contarCatalogo(shop);
  if (before === 0) {
    const message = "Curadoria de Elite: 0 produtos removidos. Catálogo já estava vazio.";
    return {
      dryRun: !executar,
      before: 0,
      candidatos: 0,
      removed: 0,
      remaining: 0,
      previstoRestam: 0,
      retidos: 0,
      retidosPorMotivo: {},
      byReason: {},
      message,
    };
  }

  const fila = await dep.lerFila();
  const porSku = new Map(fila.items.map((item) => [item.sku, item]));
  /** @type {string[]} */
  const candidatos = [];
  /** @type {Map<string, { action: string, reason: string }>} */
  const acoesPorSku = new Map();
  /** @type {Record<string, number>} */
  const byReason = {};
  /** @type {Record<string, number>} */
  const retidosPorMotivo = {};
  /** @type {string | null} */
  let cursor = null;

  for (;;) {
    const lote = await dep.lerLote({ shop, cursor });
    if (!lote.length) break;
    cursor = lote[lote.length - 1].sku;
    for (const row of lote) {
      const elite = evaluateEliteCuration(catalogRowToEvaluateRecord(row));
      if (!elite.action) continue;
      const decisao = avaliarPurgaDeEntrada(porSku.get(row.sku));
      if (!decisao.pode) {
        retidosPorMotivo[decisao.motivo] = (retidosPorMotivo[decisao.motivo] || 0) + 1;
        continue;
      }
      candidatos.push(row.sku);
      const chave = elite.reasons[0] || elite.action;
      acoesPorSku.set(row.sku, { action: elite.action, reason: chave });
      byReason[chave] = (byReason[chave] || 0) + 1;
    }
  }

  if (!executar) {
    const { alteradas } = aplicarPurgaNaFila(structuredClone(fila), shop, acoesPorSku);
    const retidos = somar(retidosPorMotivo);
    const previstoRestam = before - candidatos.length;
    return {
      dryRun: true,
      before,
      candidatos: candidatos.length,
      removed: 0,
      remaining: before,
      previstoRestam,
      filaAlteradas: alteradas,
      retidos,
      retidosPorMotivo,
      byReason,
      message: `Dry-run da Curadoria de Elite: sairiam ${candidatos.length.toLocaleString("pt-PT")} produtos e ficariam ${retidos.toLocaleString("pt-PT")} retidos (decisão humana, publicados ou sem entrada na fila). Restariam ${previstoRestam.toLocaleString("pt-PT")} no catálogo. Nada foi escrito.`,
    };
  }

  // 1) A fila primeiro, sob o lock, com a decisão relida ali. Se falhar, nada sai do catálogo.
  const { alteradas, podemSairDoCatalogo } = await dep.mutarFila((fila2) => {
    const resultado = aplicarPurgaNaFila(fila2, shop, acoesPorSku);
    return { gravar: resultado.alteradas > 0, valor: resultado };
  });

  // 2) Só saem os SKU que a decisão, relida sob o lock, ainda deixa sair.
  const saem = candidatos.filter((sku) => podemSairDoCatalogo.has(sku));
  if (saem.length < candidatos.length) {
    retidosPorMotivo.decisao_mudou = candidatos.length - saem.length;
  }
  let removed = 0;
  for (let i = 0; i < saem.length; i += DELETE_BATCH) {
    const slice = saem.slice(i, i + DELETE_BATCH);
    await dep.apagarLote({ shop, skus: slice });
    removed += slice.length;
  }

  const remaining = await dep.contarCatalogo(shop);
  const retidos = somar(retidosPorMotivo);
  const message = `Curadoria de Elite concluída. Removidos ${removed.toLocaleString("pt-PT")} produtos. Retidos ${retidos.toLocaleString("pt-PT")} (decisão humana, publicados ou sem entrada na fila). Restam ${remaining.toLocaleString("pt-PT")} no catálogo.`;

  // 3) O log por último, com os retidos e o motivo de cada um.
  await dep.escreverLog(shop, {
    shop,
    at: new Date().toISOString(),
    before,
    removed,
    remaining,
    retidos,
    retidosPorMotivo,
    filaAlteradas: alteradas,
    message,
    byReason,
  });

  return {
    dryRun: false,
    before,
    candidatos: candidatos.length,
    removed,
    remaining,
    retidos,
    retidosPorMotivo,
    filaAlteradas: alteradas,
    byReason,
    message,
  };
}

export async function readElitePurgeLog(shop) {
  try {
    const raw = await fs.readFile(elitePurgeLogPath(shop), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
