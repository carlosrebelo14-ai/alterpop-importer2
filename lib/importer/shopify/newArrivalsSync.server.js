/**
 * new-arrivals — janela de N dias por `published_at` (ENTREGA 2 · Tarefa 6).
 *
 * A coleção `new-arrivals` é smart, regra `TAG EQUALS "new-arrival"` (Shopify não tem
 * coluna de data em smart collections — não dá para `published_at` nativo). Este
 * reconciliador dá-lhe a semântica de janela:
 *
 *   1. produtos publicados nos últimos N dias  → garantem a tag `new-arrival`
 *   2. produtos com a tag mas publicados há > N dias → perdem a tag
 *
 * Auto-corretivo: corre a cada ciclo (api.trigger-sync.jsx), não depende de o publish
 * lembrar-se de pôr a tag. Um reimport em massa NÃO mete a tag em lado nenhum — a tag
 * só é gerida aqui, por data de publicação real da Shopify.
 *
 * N por defeito = 30 (decisão do Carlos, ENTREGA 2). Override: NEW_ARRIVALS_WINDOW_DAYS.
 *
 * Falha em silêncio (loga, não propaga) — nunca faz o ciclo falhar.
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 * @param {{ windowDays?: number }} [opts]
 * @returns {Promise<{ ok: boolean, windowDays?: number, tagged?: number, untagged?: number, scanned?: number, error?: string }>}
 */

const NEW_ARRIVAL_TAG = "new-arrival";

const PRODUCTS_PAGE = `
  query NewArrivalsScan($query: String!, $cursor: String) {
    products(first: 100, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { id tags publishedAt }
    }
  }
`;

const TAGS_ADD = `
  mutation NewArrivalsTagAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }
`;
const TAGS_REMOVE = `
  mutation NewArrivalsTagRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

function resolveWindowDays(opts) {
  const fromOpts = Number(opts?.windowDays);
  if (Number.isFinite(fromOpts) && fromOpts > 0) return Math.floor(fromOpts);
  const fromEnv = Number(process.env.NEW_ARRIVALS_WINDOW_DAYS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 30;
}

async function pageAll(client, query) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 50; p++) {
    const data = await client.graphql(PRODUCTS_PAGE, { query, cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) out.push(n);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

export async function syncNewArrivalsTag(client, shop, opts = {}) {
  const windowDays = resolveWindowDays(opts);
  try {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const cutoffISO = cutoff.toISOString();
    // Shopify search: aceita `published_at:>2026-08-11T...` e `published_at:<...`.
    const inWindow = await pageAll(client, `published_status:published AND published_at:>'${cutoffISO}'`);
    const stale = await pageAll(client, `tag:'${NEW_ARRIVAL_TAG}' AND published_at:<'${cutoffISO}'`);

    let tagged = 0;
    let untagged = 0;

    for (const p of inWindow) {
      if ((p.tags || []).includes(NEW_ARRIVAL_TAG)) continue;
      const res = await client.graphql(TAGS_ADD, { id: p.id, tags: [NEW_ARRIVAL_TAG] });
      const errs = res.tagsAdd?.userErrors || [];
      if (errs.length) {
        console.warn(`[new-arrivals] tagsAdd falhou ${p.id}: ${errs.map((e) => e.message).join("; ")}`);
      } else {
        tagged += 1;
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    for (const p of stale) {
      if (!(p.tags || []).includes(NEW_ARRIVAL_TAG)) continue;
      const res = await client.graphql(TAGS_REMOVE, { id: p.id, tags: [NEW_ARRIVAL_TAG] });
      const errs = res.tagsRemove?.userErrors || [];
      if (errs.length) {
        console.warn(`[new-arrivals] tagsRemove falhou ${p.id}: ${errs.map((e) => e.message).join("; ")}`);
      } else {
        untagged += 1;
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    return {
      ok: true,
      windowDays,
      tagged,
      untagged,
      scanned: inWindow.length + stale.length,
    };
  } catch (err) {
    console.error("[new-arrivals] sync falhou:", err?.message || err);
    return { ok: false, windowDays, error: err?.message || String(err) };
  }
}

export { NEW_ARRIVAL_TAG };
