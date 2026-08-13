import { getDefaultConfig } from "./config.js";
import { runThrottled } from "./shopifyRateLimiter.js";

const MAX_RETRIES = 5;

export class ShopifyClient {
  /**
   * @param {{ store: string, accessToken: string, apiVersion?: string }} opts
   */
  constructor(opts) {
    const cfg = getDefaultConfig().shopify;
    const store = opts.store.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const apiVersion = opts.apiVersion || cfg.apiVersion;
    if (!store || !opts.accessToken) {
      throw new Error("Shopify store and access token are required");
    }
    this.store = store;
    this.endpoint = `https://${store}/admin/api/${apiVersion}/graphql.json`;
    this.accessToken = opts.accessToken;
    this.stats = { rateLimitRetries: 0, throttleRetries: 0, serverErrorRetries: 0 };
  }

  async graphql(query, variables = {}) {
    return runThrottled(() => this.graphqlRaw(query, variables));
  }

  async graphqlRaw(query, variables = {}) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 429) {
        this.stats.rateLimitRetries++;
        const retryHeader = parseInt(res.headers.get("Retry-After") || "2", 10);
        const backoff = Math.min(1000 * 2 ** attempt, 30000);
        await sleep(Math.max(retryHeader * 1000, backoff));
        continue;
      }

      // Fix (code review 2026-08-13): 5xx (blips transitórios da infraestrutura da
      // própria Shopify — já aconteceram, não são hipotéticos) falhavam de imediato
      // sem retry, ao contrário do 429/THROTTLED que já tinham rede de segurança.
      // Repete com o mesmo backoff exponencial do 429, sem tentar ler o corpo (pode
      // nem ser JSON — ex.: página de erro HTML de um 502/503).
      if (res.status >= 500 && res.status < 600) {
        this.stats.serverErrorRetries++;
        const backoff = Math.min(1000 * 2 ** attempt, 30000);
        await sleep(backoff);
        continue;
      }

      let body;
      try {
        body = await res.json();
      } catch (parseErr) {
        throw new Error(`Shopify HTTP ${res.status}: resposta não é JSON válido (${parseErr.message})`);
      }
      if (!res.ok) {
        throw new Error(`Shopify HTTP ${res.status}: ${JSON.stringify(body)}`);
      }

      // A Admin API GraphQL não usa 429 para o throttling por custo: devolve HTTP 200
      // com o erro no corpo. Sem este ramo, um throttle era tratado como falha
      // definitiva do produto e marcava SYNC_ERROR em vez de esperar e repetir.
      if (isThrottledResponse(body)) {
        this.stats.throttleRetries++;
        const waitMs = throttleWaitMs(body, attempt);
        await sleep(waitMs);
        continue;
      }

      if (body.errors?.length) {
        throw new Error(body.errors.map((e) => e.message).join("; "));
      }
      return body.data;
    }
    throw new Error("Shopify request failed after retries");
  }
}

/**
 * @param {{ shop: string, accessToken: string }} session
 */
export function createShopifyClientFromSession(session) {
  return new ShopifyClient({
    store: session.shop,
    accessToken: session.accessToken,
  });
}

/**
 * A Shopify sinaliza throttling por custo com HTTP 200 e
 * `errors[].extensions.code === "THROTTLED"` — não com 429.
 * @param {any} body corpo JSON da resposta GraphQL
 */
export function isThrottledResponse(body) {
  const errors = body?.errors;
  if (!Array.isArray(errors) || !errors.length) return false;
  return errors.some(
    (e) =>
      e?.extensions?.code === "THROTTLED" ||
      String(e?.message || "").toLowerCase().includes("throttled")
  );
}

/**
 * Quanto esperar antes de repetir uma query estrangulada.
 *
 * Usa o `throttleStatus` que a Shopify devolve — quanto falta do custo pedido a dividir
 * pelo ritmo de reposição do bucket — em vez de adivinhar. Sem esses campos, cai num
 * backoff exponencial igual ao do 429.
 *
 * @param {any} body
 * @param {number} attempt tentativa atual (0-based)
 * @returns {number} milissegundos
 */
export function throttleWaitMs(body, attempt = 0) {
  const cost = body?.extensions?.cost;
  const st = cost?.throttleStatus;
  const requested = Number(cost?.requestedQueryCost);
  const available = Number(st?.currentlyAvailable);
  const restoreRate = Number(st?.restoreRate);

  if (
    Number.isFinite(requested) &&
    Number.isFinite(available) &&
    Number.isFinite(restoreRate) &&
    restoreRate > 0
  ) {
    const deficit = requested - available;
    if (deficit > 0) {
      // +250ms de folga: o bucket repõe continuamente e ficar à tangente volta a falhar.
      return Math.min(Math.ceil((deficit / restoreRate) * 1000) + 250, 30000);
    }
    return 1000;
  }

  return Math.min(2000 * 2 ** attempt, 30000);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchLocations(client) {
  const data = await client.graphql(`
    query Locations {
      locations(first: 20) {
        nodes {
          id
          name
          isActive
          fulfillsOnlineOrders
        }
      }
    }
  `);
  return data.locations.nodes;
}

/**
 * Localização predefinida da loja (primeira activa / que cumpre encomendas online).
 * @param {import('./shopifyClient.js').ShopifyClient} client
 */
export async function fetchPrimaryLocationId(client) {
  const data = await client.graphql(`
    query ShopPrimaryLocation {
      shop {
        locations(first: 1) {
          nodes {
            id
            name
            isActive
            fulfillsOnlineOrders
          }
        }
      }
      locations(first: 20) {
        nodes {
          id
          name
          isActive
          fulfillsOnlineOrders
        }
      }
    }
  `);

  const shopNodes = data.shop?.locations?.nodes || [];
  const allNodes = data.locations?.nodes || [];
  const pool = shopNodes.length ? shopNodes : allNodes;
  const primary =
    pool.find((l) => l.isActive && l.fulfillsOnlineOrders) ||
    pool.find((l) => l.isActive) ||
    pool[0] ||
    allNodes.find((l) => l.fulfillsOnlineOrders) ||
    allNodes[0];

  if (!primary?.id) throw new Error("No inventory location found in store");
  return primary.id;
}

export async function resolveLocationId(client, configuredId) {
  if (configuredId) return configuredId;
  return fetchPrimaryLocationId(client);
}

const INVENTORY_ITEM_UPDATE = `
  mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id tracked }
      userErrors { field message }
    }
  }
`;

const INVENTORY_ACTIVATE = `
  mutation InventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }
`;

const INVENTORY_AVAILABLE_QUERY = `
  query InventoryAvailableAtLocation($inventoryItemId: ID!, $locationId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available"]) {
          name
          quantity
        }
      }
    }
  }
`;

const INVENTORY_ADJUST = `
  mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

/**
 * Sincroniza stock disponível via inventoryAdjustQuantities (delta até ao alvo).
 * API 2025-10 — evita ignoreCompareQuantity de inventorySetQuantities.
 *
 * @param {ShopifyClient} client
 * @param {{
 *   inventoryItemId: string,
 *   locationId: string,
 *   quantity: number,
 *   referenceDocumentUri?: string,
 * }} params
 */
export async function updateInventory(client, params) {
  const { inventoryItemId, locationId, quantity, referenceDocumentUri } = params;
  const targetQty = Math.max(0, Math.floor(Number(quantity) || 0));

  const tracked = await client.graphql(INVENTORY_ITEM_UPDATE, {
    id: inventoryItemId,
    input: { tracked: true },
  });
  const trackErrors = tracked.inventoryItemUpdate?.userErrors || [];
  if (trackErrors.length) {
    throw new Error(trackErrors.map((e) => e.message).join("; "));
  }

  const activated = await client.graphql(INVENTORY_ACTIVATE, {
    inventoryItemId,
    locationId,
    available: targetQty,
  });
  const activateErrors = activated.inventoryActivate?.userErrors || [];
  if (activateErrors.length) {
    const msg = activateErrors.map((e) => e.message).join("; ");
    if (!/already|exists/i.test(msg)) throw new Error(msg);
  }

  const levelData = await client.graphql(INVENTORY_AVAILABLE_QUERY, {
    inventoryItemId,
    locationId,
  });
  const availableEntry = levelData.inventoryItem?.inventoryLevel?.quantities?.find(
    (q) => q.name === "available"
  );
  const currentQty = availableEntry?.quantity ?? 0;
  const delta = targetQty - currentQty;

  if (delta === 0) {
    return { skipped: true, currentQty, targetQty };
  }

  const input = {
    name: "available",
    reason: "correction",
    changes: [
      {
        inventoryItemId,
        locationId,
        delta,
      },
    ],
  };

  if (referenceDocumentUri && /^https?:\/\//i.test(referenceDocumentUri)) {
    input.referenceDocumentUri = referenceDocumentUri;
  }

  const data = await client.graphql(INVENTORY_ADJUST, { input });
  const errors = data.inventoryAdjustQuantities?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }

  return data.inventoryAdjustQuantities;
}
