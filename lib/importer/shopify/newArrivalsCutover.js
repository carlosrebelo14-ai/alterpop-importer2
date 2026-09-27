/**
 * Corte do N1 (briefing 27/09) — partes puras do script
 * scripts/catalog/new-arrivals-cutover.js (passos 1 a 3 da sequência de corte):
 *   1. definições (P4 — ver newArrivalsDefinitions.js)
 *   2. backfill de first_published_at / is_new_arrival nos ACTIVE publicados
 *   3. regra da new-arrivals passa a alterpop.is_new_arrival EQUALS true
 *
 * Sem Shopify, sem fs. Testado em scripts/tests/new-arrivals-cutover.test.js.
 */
import { computeIsNewArrival, NEW_ARRIVAL_DAYS } from "./newArrivals.server.js";

/** Diferença acima da qual as duas fontes de data contam como divergentes. As duas
 *  gravam-se no mesmo publish (a fila marca PUBLISHED logo a seguir), por isso segundos
 *  ou minutos de diferença são ruído, não divergência. */
export const DIVERGENCE_THRESHOLD_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Data de primeira publicação para o backfill. Fonte preferida: o registo de publicação
 * da app (curation-queue, metadata.publishedAt); recurso: publishedAt da Shopify. Com as
 * duas, escolhe a MAIS ANTIGA — nenhuma das duas é "primeira" por construção (a fila e a
 * Shopify reescrevem a data a cada publicação), a mais antiga é a mais próxima.
 *
 * @param {{ queuePublishedAt?: string|null, shopifyPublishedAt?: string|null }} src
 * @returns {{ value: string|null, source: "queue"|"shopify"|null, divergenceMs: number|null }}
 */
export function pickFirstPublishedAt({ queuePublishedAt, shopifyPublishedAt }) {
  const q = queuePublishedAt ? new Date(queuePublishedAt).getTime() : NaN;
  const s = shopifyPublishedAt ? new Date(shopifyPublishedAt).getTime() : NaN;
  const hasQ = Number.isFinite(q);
  const hasS = Number.isFinite(s);
  if (!hasQ && !hasS) return { value: null, source: null, divergenceMs: null };
  if (hasQ && !hasS) return { value: new Date(q).toISOString(), source: "queue", divergenceMs: null };
  if (!hasQ && hasS) return { value: new Date(s).toISOString(), source: "shopify", divergenceMs: null };
  return q <= s
    ? { value: new Date(q).toISOString(), source: "queue", divergenceMs: s - q }
    : { value: new Date(s).toISOString(), source: "shopify", divergenceMs: q - s };
}

/**
 * Plano do backfill (passo 2). Só ACTIVE publicados no Online Store; quem já tem
 * first_published_at fica como está (idempotente, e a data nunca se reescreve).
 *
 * @param {Array<{ productId: string, handle: string, sku: string|null, publishedAt: string|null,
 *                 firstPublishedAt: string|null, isNewArrival: boolean|null }>} activeProducts
 * @param {Map<string, string>} queuePublishedAtBySku
 * @param {Date} now
 */
export function planNewArrivalsBackfill(activeProducts, queuePublishedAtBySku, now) {
  const rows = [];
  const writes = [];
  const alreadySet = [];
  const unpublished = [];
  const divergences = [];

  for (const p of activeProducts) {
    if (p.firstPublishedAt) {
      alreadySet.push(p);
      continue;
    }
    if (!p.publishedAt) {
      unpublished.push(p);
      continue;
    }
    const pick = pickFirstPublishedAt({
      queuePublishedAt: p.sku ? queuePublishedAtBySku.get(p.sku) || null : null,
      shopifyPublishedAt: p.publishedAt,
    });
    const isNew = computeIsNewArrival(pick.value, now);
    rows.push({ ...p, backfillAt: pick.value, source: pick.source, divergenceMs: pick.divergenceMs, isNew });
    if (pick.divergenceMs != null && pick.divergenceMs > DIVERGENCE_THRESHOLD_MS) {
      divergences.push({
        sku: p.sku,
        handle: p.handle,
        queue: queuePublishedAtBySku.get(p.sku),
        shopify: p.publishedAt,
        chosen: pick.source,
      });
    }
    writes.push(
      { ownerId: p.productId, namespace: "alterpop", key: "first_published_at", type: "date_time", value: pick.value },
      { ownerId: p.productId, namespace: "alterpop", key: "is_new_arrival", type: "boolean", value: String(isNew) },
    );
  }

  return {
    rows,
    writes,
    alreadySet,
    unpublished,
    divergences,
    expectedTrue: rows.filter((r) => r.isNew).length + alreadySet.filter((p) => p.isNewArrival === true).length,
    processed: rows.length + alreadySet.length + unpublished.length,
  };
}

/**
 * Publicações por dia (UTC) com a data em que esse lote sai das Novidades — mostra os
 * lotes que expiram juntos.
 * @param {Array<{ backfillAt: string }>} rows
 * @returns {Array<{ day: string, count: number, expiresOn: string }>}
 */
export function distributionByDay(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = r.backfillAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({
      day,
      count,
      // Dia em que o lote sai: fpa + NEW_ARRIVAL_DAYS (no primeiro ciclo depois da hora
      // de publicação desse dia). Piloto de 12/09 → 12/10.
      expiresOn: new Date(new Date(`${day}T00:00:00Z`).getTime() + NEW_ARRIVAL_DAYS * DAY_MS).toISOString().slice(0, 10),
    }));
}

/**
 * Regra nova da new-arrivals (passo 3). Substitui a regra inteira — TAG new-arrival sai.
 * @param {string} isNewArrivalDefinitionId GID da definição alterpop.is_new_arrival
 */
export function buildNewArrivalsRuleSet(isNewArrivalDefinitionId) {
  if (!isNewArrivalDefinitionId) throw new Error("buildNewArrivalsRuleSet: falta o GID da definição is_new_arrival");
  return {
    appliedDisjunctively: false,
    rules: [
      {
        column: "PRODUCT_METAFIELD_DEFINITION",
        relation: "EQUALS",
        condition: "true",
        conditionObjectId: isNewArrivalDefinitionId,
      },
    ],
  };
}
