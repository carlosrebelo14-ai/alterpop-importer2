import { resolveSessionStorage } from "./resolveSessionStorage.js";

/** @type {import('@shopify/shopify-app-session-storage').SessionStorage | null} */
let sessionStorageSingleton = null;

function getSessionStorage() {
  if (!sessionStorageSingleton) {
    sessionStorageSingleton = resolveSessionStorage();
  }
  return sessionStorageSingleton;
}

/** Renovar ~5 min antes de expirar. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class ShopifyAuthSessionError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "ShopifyAuthSessionError";
    this.code = opts.code || "auth_session";
    this.status = opts.status || 401;
  }
}

/**
 * @param {string} shop
 */
export function offlineSessionIdForShop(shop) {
  return `offline_${shop}`;
}

/**
 * @param {string | undefined | null} raw
 */
function normalizeShopDomain(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
}

/**
 * @param {Session} session
 */
function sessionNeedsRefresh(session) {
  if (!session.expires) return true;
  const expiresAt = new Date(session.expires).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= Date.now() + EXPIRY_BUFFER_MS;
}

/**
 * @param {Session} session
 */
async function refreshOfflineSessionTokens(session) {
  const shop = session.shop;
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_API_SECRET_KEY;

  if (!apiKey || !apiSecret) {
    throw new ShopifyAuthSessionError(
      "SHOPIFY_API_KEY / SHOPIFY_API_SECRET em falta no servidor."
    );
  }

  if (!session.refreshToken) {
    throw new ShopifyAuthSessionError(
      "Sessão Shopify expirada e sem refresh token. Abre a app no Admin da loja para voltar a autenticar.",
      { code: "auth_relogin_required" }
    );
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
  });

  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (!res.ok) {
    const detail =
      body.error_description ||
      body.error ||
      (typeof body.errors === "string" ? body.errors : null) ||
      `HTTP ${res.status}`;
    throw new ShopifyAuthSessionError(
      `Não foi possível renovar o token Shopify (${detail}). Abre a app no Admin e tenta de novo.`,
      { code: "auth_refresh_failed", status: res.status }
    );
  }

  session.accessToken = body.access_token;

  if (body.expires_in != null) {
    session.expires = new Date(Date.now() + Number(body.expires_in) * 1000);
  }
  if (body.refresh_token) {
    session.refreshToken = body.refresh_token;
  }
  if (body.refresh_token_expires_in != null) {
    session.refreshTokenExpires = new Date(
      Date.now() + Number(body.refresh_token_expires_in) * 1000
    );
  }
  if (body.scope) {
    session.scope = body.scope;
  }

  await getSessionStorage().storeSession(session);
  console.log(
    `[session] Token offline renovado para ${shop} (expira ${session.expires?.toISOString?.() || "—"})`
  );

  return session;
}

/**
 * Carrega a sessão offline persistida e renova o access token se estiver expirado.
 * Usar em jobs em background (sync Shopify) — nunca confiar no token do pedido HTTP.
 *
 * @param {string} shop
 * @returns {Promise<{ shop: string, accessToken: string }>}
 */
export async function loadOfflineSessionForShop(shop) {
  if (!shop) {
    throw new ShopifyAuthSessionError("Loja (shop) em falta na sessão.");
  }

  const normalizedRequestedShop = normalizeShopDomain(shop);
  const sessionId = offlineSessionIdForShop(normalizedRequestedShop);
  let session = await getSessionStorage().loadSession(sessionId);

  if (!session?.accessToken) {
    const envShop = normalizeShopDomain(
      process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP
    );
    const envAccessToken = String(process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
    const canUseEnvFallback =
      envShop &&
      envAccessToken &&
      (!normalizedRequestedShop || normalizedRequestedShop === envShop);

    if (canUseEnvFallback) {
      return {
        shop: envShop,
        accessToken: envAccessToken,
      };
    }

    throw new ShopifyAuthSessionError(
      `Sem sessão OAuth para ${normalizedRequestedShop}. Abre a app em Apps → Alterpop no Admin Shopify.`,
      { code: "auth_missing_session" }
    );
  }

  if (sessionNeedsRefresh(session)) {
    session = await refreshOfflineSessionTokens(session);
  }

  return {
    shop: normalizeShopDomain(session.shop),
    accessToken: session.accessToken,
  };
}

const SESSION_ERROR_PATTERN = /401|invalid api key|access token|unrecognized login/i;
const SCOPE_ERROR_PATTERN = /access denied|access scope|required access|write_products|write_publications|permission/i;

/**
 * Sessão inválida/expirada — recarregar a sessão e repetir o pedido pode resolver.
 * @param {Error} err
 */
export function isShopifySessionError(err) {
  if (err instanceof ShopifyAuthSessionError) return true;
  return SESSION_ERROR_PATTERN.test(String(err?.message || ""));
}

/**
 * Scope em falta na sessão — recarregar a sessão NUNCA resolve isto (o scope continua
 * em falta); só reautorização manual no Admin resolve. Retry cego aqui só desperdiça
 * trabalho (ex.: cria produtos a dobrar quando o publish falha a meio da criação —
 * ver shopifyApprovedSync.server.js).
 * @param {Error} err
 */
export function isShopifyScopeError(err) {
  return SCOPE_ERROR_PATTERN.test(String(err?.message || ""));
}

/**
 * Classificação ampla para mensagens/telemetria — engloba sessão e scope.
 * Não usar para decidir se vale a pena repetir o pedido (usar isShopifySessionError).
 * @param {Error} err
 */
export function isShopifyAuthError(err) {
  return isShopifySessionError(err) || isShopifyScopeError(err);
}
