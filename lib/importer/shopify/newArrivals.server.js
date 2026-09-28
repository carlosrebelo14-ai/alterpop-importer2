/**
 * newArrivals — N1 (briefing 27/09, revisto no mesmo dia). Substitui newArrivalsSync.
 *
 * A coleção `new-arrivals` passa a ser smart por `alterpop.is_new_arrival EQUALS true`
 * (em vez de `TAG EQUALS new-arrival`). A data de referência é
 * `alterpop.first_published_at`, escrita UMA vez e nunca reescrita — uma republicação
 * (que muda o publishedAt da Shopify) já não faz um produto antigo reentrar em
 * Novidades. Só metafieldsSet; nunca tags.
 *
 * Quem escreve:
 *   - publisher, na primeira publicação (createNewProduct) — first_published_at = agora,
 *     is_new_arrival = true;
 *   - este ciclo (trigger-sync):
 *       · produto ACTIVE e publicado sem first_published_at → first_published_at =
 *         publishedAt, is_new_arrival calculado (um rascunho ativado à mão no Admin nunca
 *         passa pelo publisher);
 *       · first_published_at + NEW_ARRIVAL_DAYS < agora e is_new_arrival = true → false.
 *
 * V15 (sem travão por volume — a publicação chega em lotes, e 44 One Piece + 13 Luke a
 * 16/09 expiram juntos a 16/10; um travão por contagem dava falso alarme garantido):
 *   - vermelho: produto `true` sem first_published_at; first_published_at no futuro;
 *     first_published_at diferente do lido no ciclo anterior. Esses produtos NÃO são
 *     escritos — ficam para um humano. Também vermelho: erro de escrita, definição em
 *     falta, falha de leitura.
 *   - amarelo: houve expirações ou preenchimentos no ciclo (com a lista).
 *   - verde: nada a fazer e nenhuma anomalia.
 *
 * Nunca falha em silêncio: reconcileNewArrivalsCycle grava sempre o estado V15, também
 * quando lança.
 */
import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";

/** Janela das Novidades, em dias — no topo do ficheiro, como pede o briefing. */
export const NEW_ARRIVAL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tolerância para relógios: uma data até 5 min à frente não conta como "futuro". */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
/** metafieldsSet aceita no máximo 25 metafields por chamada. */
const METAFIELDS_PER_CALL = 25;

/** dataDir entra por argumento nos testes (diretório temporário); em produção é o
 *  volume de dados da config. */
function v15StatePath(dataDir = getDefaultConfig().paths.data) {
  return path.join(dataDir, "v15-new-arrivals-state.json");
}
function snapshotPath(dataDir = getDefaultConfig().paths.data) {
  return path.join(dataDir, "new-arrivals-first-published-snapshot.json");
}

/**
 * is_new_arrival para uma data de primeira publicação. true enquanto
 * first_published_at + NEW_ARRIVAL_DAYS >= agora. Pura.
 * @param {string|Date} firstPublishedAt
 * @param {Date} now
 */
export function computeIsNewArrival(firstPublishedAt, now) {
  const t = new Date(firstPublishedAt).getTime();
  if (!Number.isFinite(t)) throw new Error(`first_published_at inválido: ${firstPublishedAt}`);
  return t + NEW_ARRIVAL_DAYS * DAY_MS >= now.getTime();
}

/** "true"/"false" (valor de metafield boolean) → boolean; ausente → null. */
export function parseBooleanMetafield(value) {
  if (value == null) return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * Metafields a escrever na PRIMEIRA publicação (publisher). Pura.
 * @param {string} productId
 * @param {Date} now
 */
export function buildFirstPublicationMetafields(productId, now) {
  return [
    { ownerId: productId, namespace: "alterpop", key: "first_published_at", type: "date_time", value: now.toISOString() },
    { ownerId: productId, namespace: "alterpop", key: "is_new_arrival", type: "boolean", value: "true" },
  ];
}

/**
 * Decisão do ciclo. Pura — sem Shopify, sem fs.
 *
 * @param {Array<{ productId: string, handle: string, sku: string|null, publishedAt: string|null,
 *                 firstPublishedAt: string|null, isNewArrival: boolean|null }>} products
 *   produtos ACTIVE (a query já filtra status).
 * @param {Record<string, string>} snapshot productId → first_published_at lido no ciclo anterior
 * @param {Date} now
 * @returns {{ status: "green"|"yellow"|"red", expirations: object[], fills: object[],
 *             anomalies: object[], writes: object[], nextSnapshot: Record<string,string>,
 *             evaluated: number }}
 */
export function decideNewArrivalsCycle(products, snapshot, now) {
  const expirations = [];
  const fills = [];
  const anomalies = [];
  const writes = [];
  const nextSnapshot = { ...snapshot };
  let evaluated = 0;

  for (const p of products) {
    evaluated += 1;
    const base = { productId: p.productId, handle: p.handle, sku: p.sku };

    if (!p.firstPublishedAt) {
      if (p.isNewArrival === true) {
        anomalies.push({ ...base, code: "TRUE_WITHOUT_DATE", detail: "is_new_arrival=true sem first_published_at" });
        continue;
      }
      // Só entra quem está publicado no Online Store. ACTIVE sem publishedAt fica de fora.
      if (!p.publishedAt) continue;
      const isNew = computeIsNewArrival(p.publishedAt, now);
      fills.push({ ...base, firstPublishedAt: p.publishedAt, isNewArrival: isNew });
      writes.push(
        { ownerId: p.productId, namespace: "alterpop", key: "first_published_at", type: "date_time", value: p.publishedAt },
        { ownerId: p.productId, namespace: "alterpop", key: "is_new_arrival", type: "boolean", value: String(isNew) },
      );
      nextSnapshot[p.productId] = p.publishedAt;
      continue;
    }

    const t = new Date(p.firstPublishedAt).getTime();
    if (!Number.isFinite(t)) {
      anomalies.push({ ...base, code: "INVALID_DATE", detail: `first_published_at inválido: ${p.firstPublishedAt}` });
      continue;
    }
    if (t > now.getTime() + FUTURE_TOLERANCE_MS) {
      anomalies.push({ ...base, code: "FUTURE_DATE", detail: `first_published_at no futuro: ${p.firstPublishedAt}` });
      continue;
    }
    const previous = snapshot[p.productId];
    if (previous && new Date(previous).getTime() !== t) {
      // O snapshot mantém o valor antigo: o vermelho persiste até alguém repor a data.
      anomalies.push({
        ...base,
        code: "DATE_CHANGED",
        detail: `first_published_at mudou desde o último ciclo: ${previous} → ${p.firstPublishedAt}`,
      });
      continue;
    }
    nextSnapshot[p.productId] = p.firstPublishedAt;

    const shouldBeNew = computeIsNewArrival(p.firstPublishedAt, now);
    if (p.isNewArrival === true && !shouldBeNew) {
      expirations.push({ ...base, firstPublishedAt: p.firstPublishedAt });
      writes.push({ ownerId: p.productId, namespace: "alterpop", key: "is_new_arrival", type: "boolean", value: "false" });
    } else if (p.isNewArrival == null) {
      // Data escrita, flag em falta (escrita parcial) — completa com o valor calculado.
      fills.push({ ...base, firstPublishedAt: p.firstPublishedAt, isNewArrival: shouldBeNew });
      writes.push({ ownerId: p.productId, namespace: "alterpop", key: "is_new_arrival", type: "boolean", value: String(shouldBeNew) });
    }
    // is_new_arrival=false dentro da janela: não reativa — a regra só expira.
  }

  const status = anomalies.length ? "red" : expirations.length || fills.length ? "yellow" : "green";
  return { status, expirations, fills, anomalies, writes, nextSnapshot, evaluated };
}

const ACTIVE_PRODUCTS_QUERY = `
  query NewArrivalsActive($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        status
        createdAt
        publishedAt
        variants(first: 1) { nodes { sku } }
        firstPublishedAt: metafield(namespace: "alterpop", key: "first_published_at") { value }
        isNewArrival: metafield(namespace: "alterpop", key: "is_new_arrival") { value }
      }
    }
  }
`;

const DEFINITIONS_QUERY = `
  query NewArrivalsDefinitions {
    isNew: metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "alterpop", key: "is_new_arrival") { nodes { id } }
    firstAt: metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "alterpop", key: "first_published_at") { nodes { id } }
  }
`;

const METAFIELDS_SET = `
  mutation NewArrivalsMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key value owner { ... on Product { id } } }
      userErrors { field message code }
    }
  }
`;

/** Lê todos os ACTIVE com os dois metafields do N1, já no formato de decideNewArrivalsCycle. */
export async function fetchActiveNewArrivalState(client) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(ACTIVE_PRODUCTS_QUERY, { cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) {
      out.push({
        productId: n.id,
        handle: n.handle,
        status: n.status,
        sku: n.variants?.nodes?.[0]?.sku || null,
        createdAt: n.createdAt,
        publishedAt: n.publishedAt || null,
        firstPublishedAt: n.firstPublishedAt?.value || null,
        isNewArrival: parseBooleanMetafield(n.isNewArrival?.value),
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

/**
 * Escreve metafields em lotes de METAFIELDS_PER_CALL. Devolve os erros (nunca engole).
 * @returns {Promise<{ written: number, errors: Array<{ productIds: string[], message: string }> }>}
 */
export async function writeNewArrivalMetafields(client, metafields) {
  let written = 0;
  const errors = [];
  for (let i = 0; i < metafields.length; i += METAFIELDS_PER_CALL) {
    const chunk = metafields.slice(i, i + METAFIELDS_PER_CALL);
    const productIds = [...new Set(chunk.map((m) => m.ownerId))];
    try {
      const data = await client.graphql(METAFIELDS_SET, { metafields: chunk });
      const userErrors = data.metafieldsSet?.userErrors || [];
      if (userErrors.length) {
        errors.push({ productIds, message: userErrors.map((e) => e.message).join("; ") });
      } else {
        written += data.metafieldsSet?.metafields?.length ?? 0;
      }
    } catch (err) {
      errors.push({ productIds, message: err?.message || String(err) });
    }
  }
  return { written, errors };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`FALHA DE LEITURA (${file}): ${err?.message || err}`);
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

/** Último estado V15 gravado — lido pelo portão (pre-pilot-verify.js). */
export async function loadNewArrivalsCycleState(dataDir) {
  return readJson(v15StatePath(dataDir));
}

/**
 * Ciclo do trigger-sync. Grava SEMPRE o estado V15, também em falha.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 * @param {{ now?: Date, dataDir?: string }} [opts]
 */
export async function reconcileNewArrivalsCycle(client, shop, opts = {}) {
  const now = opts.now || new Date();
  const statePath = v15StatePath(opts.dataDir);
  const snapPath = snapshotPath(opts.dataDir);
  const base = { shop, ranAt: now.toISOString(), windowDays: NEW_ARRIVAL_DAYS };
  try {
    const defs = await client.graphql(DEFINITIONS_QUERY);
    const missing = [];
    if (!defs?.isNew?.nodes?.[0]?.id) missing.push("alterpop.is_new_arrival");
    if (!defs?.firstAt?.nodes?.[0]?.id) missing.push("alterpop.first_published_at");
    if (missing.length) {
      const state = { ...base, status: "red", reason: `definição em falta: ${missing.join(", ")} — nada escrito` };
      await writeJson(statePath, state);
      return state;
    }

    const snapshot = (await readJson(snapPath)) || {};
    const products = await fetchActiveNewArrivalState(client);
    const decision = decideNewArrivalsCycle(products, snapshot, now);

    if (decision.evaluated !== products.length) {
      throw new Error(`processed (${decision.evaluated}) != total (${products.length})`);
    }

    const { written, errors } = await writeNewArrivalMetafields(client, decision.writes);

    // O snapshot só avança para os produtos sem erro de escrita.
    const failedIds = new Set(errors.flatMap((e) => e.productIds));
    const nextSnapshot = { ...decision.nextSnapshot };
    for (const id of failedIds) {
      if (snapshot[id]) nextSnapshot[id] = snapshot[id];
      else delete nextSnapshot[id];
    }
    await writeJson(snapPath, nextSnapshot);

    const state = {
      ...base,
      status: errors.length ? "red" : decision.status,
      reason: errors.length ? `${errors.length} erro(s) de escrita` : null,
      activeCount: products.length,
      processed: decision.evaluated,
      trueCount: products.filter((p) => p.isNewArrival === true).length
        - decision.expirations.length
        + decision.fills.filter((f) => f.isNewArrival).length,
      expirations: decision.expirations,
      fills: decision.fills,
      anomalies: decision.anomalies,
      metafieldsWritten: written,
      errors,
    };
    await writeJson(statePath, state);
    return state;
  } catch (err) {
    const state = { ...base, status: "red", reason: `falhou: ${err?.message || err}` };
    try {
      await writeJson(statePath, state);
    } catch (writeErr) {
      console.error("[new-arrivals] não consegui gravar o estado V15:", writeErr?.message || writeErr);
    }
    return state;
  }
}
