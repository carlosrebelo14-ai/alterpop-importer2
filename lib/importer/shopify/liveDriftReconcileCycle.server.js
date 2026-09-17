/**
 * liveDriftReconcileCycle — item 7 (ADENDA 7, briefing backend, 17/09/2026).
 *
 * O ciclo de trigger-sync passa a corrigir sozinho o drift entre o esperado (Prisma, via
 * buildPublishPayload) e o real (metafields `alterpop.*` na Shopify) — o mesmo problema
 * que o LIVE_DRIFT da auditoria descobriu (live-publish-audit.js / liveDrift.server.js).
 *
 * Escreve SÓ metafieldsSet, SÓ metafields `alterpop.{franchise,line,format,
 * manufacturer_line}` — nunca título, preço, descrição, status ou tags. Mesma regra do
 * live-metafield-reconcile.js: só escreve quando o valor esperado é não-nulo; limpar um
 * valor antigo (esperado null, live com valor) precisava de metafieldsDelete, fora do
 * âmbito, fica reportado à parte.
 *
 * TRAVÃO (ADENDA 7) — até MAX_AUTO_RECONCILE produtos com drift no ciclo, corrige
 * sozinho (V13 amarelo, com a lista do que corrigiu). Acima disso, não escreve NADA e
 * fica vermelho com a lista completa — um erro de vocabulário (uma needle a mais numa
 * tabela) não reescreve a loja inteira sem ninguém ver antes.
 */
import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { prisma } from "../../prisma/prismaSafe.server.js";
import { buildPublishPayload } from "./shopifyMapper.server.js";
import { computeLiveDrift } from "../curation/liveDrift.server.js";

/** Nomeada no topo do ficheiro, como pede a ADENDA 7. */
export const MAX_AUTO_RECONCILE = 10;

const LIST_METAFIELD_FIELDS = new Set(["franchise", "line", "format"]);

function v13StatePath() {
  return path.join(getDefaultConfig().paths.data, "v13-live-drift-state.json");
}

const ACTIVE_PRODUCTS_QUERY = `
  query CycleDriftActive($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        variants(first: 1) { nodes { sku } }
        metafields(namespace: "alterpop", first: 10) { nodes { key value } }
      }
    }
  }
`;

const METAFIELDS_SET = `
  mutation CycleDriftMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

function metafieldValue(node, key) {
  const m = (node.metafields?.nodes || []).find((mf) => mf.key === key);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m.value);
    return Array.isArray(parsed) ? parsed[0] ?? null : m.value;
  } catch {
    return m.value;
  }
}

async function fetchAllActive(client) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(ACTIVE_PRODUCTS_QUERY, { cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) out.push(n);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

/**
 * Decide o que fazer com os produtos já identificados como tendo drift. Função pura —
 * não sabe nada de Shopify/Prisma/fs. Testável sem rede nem BD.
 *
 * @param {{ sku: string, handle: string, productId: string, drifts: { field: string, live: string|null, expected: string|null }[] }[]} productsWithDrift
 * @returns {{ status: "green"|"yellow"|"red", toWrite: object[], cannotClear: object[], blocked: object[] }}
 */
export function decideLiveDriftCycleAction(productsWithDrift) {
  if (!productsWithDrift.length) {
    return { status: "green", toWrite: [], cannotClear: [], blocked: [] };
  }
  if (productsWithDrift.length > MAX_AUTO_RECONCILE) {
    return { status: "red", toWrite: [], cannotClear: [], blocked: productsWithDrift };
  }

  const toWrite = [];
  const cannotClear = [];
  for (const p of productsWithDrift) {
    for (const d of p.drifts) {
      if (d.expected) {
        toWrite.push({ sku: p.sku, handle: p.handle, productId: p.productId, field: d.field, live: d.live, expected: d.expected });
      } else {
        cannotClear.push({ sku: p.sku, handle: p.handle, field: d.field, live: d.live });
      }
    }
  }
  return { status: "yellow", toWrite, cannotClear, blocked: [] };
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 */
export async function reconcileLiveDriftCycle(client, shop) {
  const activeNodes = await fetchAllActive(client);

  const productsWithDrift = [];
  let skippedNoCatalogRow = 0;

  for (const node of activeNodes) {
    const sku = node.variants?.nodes?.[0]?.sku || null;
    if (!sku) continue;

    const row = await prisma.catalogProduct.findFirst({ where: { shop, sku } });
    if (!row) {
      skippedNoCatalogRow += 1;
      continue;
    }

    const payload = await buildPublishPayload(row);
    const liveValues = {
      franchise: metafieldValue(node, "franchise"),
      line: metafieldValue(node, "line"),
      format: metafieldValue(node, "format"),
      manufacturer_line: metafieldValue(node, "manufacturer_line"),
    };
    const drifts = computeLiveDrift(payload, liveValues);
    if (drifts.length) {
      productsWithDrift.push({ sku, handle: node.handle, productId: node.id, drifts });
    }
  }

  const decision = decideLiveDriftCycleAction(productsWithDrift);

  const errors = [];
  if (decision.status === "yellow") {
    for (const w of decision.toWrite) {
      const isList = LIST_METAFIELD_FIELDS.has(w.field);
      try {
        const data = await client.graphql(METAFIELDS_SET, {
          metafields: [
            {
              ownerId: w.productId,
              namespace: "alterpop",
              key: w.field,
              type: isList ? "list.single_line_text_field" : "single_line_text_field",
              value: isList ? JSON.stringify([w.expected]) : w.expected,
            },
          ],
        });
        const userErrors = data.metafieldsSet?.userErrors || [];
        if (userErrors.length) {
          errors.push({ sku: w.sku, field: w.field, message: userErrors.map((e) => e.message).join("; ") });
        }
      } catch (err) {
        errors.push({ sku: w.sku, field: w.field, message: err?.message || String(err) });
      }
    }
  }

  const state = {
    status: decision.status,
    shop,
    ranAt: new Date().toISOString(),
    activeCount: activeNodes.length,
    skippedNoCatalogRow,
    corrected: decision.status === "yellow" ? decision.toWrite.filter((w) => !errors.some((e) => e.sku === w.sku && e.field === w.field)) : [],
    cannotClear: decision.cannotClear,
    blocked: decision.blocked,
    errors,
  };
  await fs.mkdir(path.dirname(v13StatePath()), { recursive: true });
  await fs.writeFile(v13StatePath(), JSON.stringify(state, null, 2), "utf8");

  return state;
}

/** Lê o último estado gravado — usado pelo V13 em pre-pilot-verify.js. */
export async function loadLiveDriftCycleState() {
  try {
    const raw = await fs.readFile(v13StatePath(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`FALHA DE LEITURA (${v13StatePath()}): ${err?.message || err}`);
  }
}
