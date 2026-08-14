import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { resolveSessionStorage } from "../lib/session/resolveSessionStorage.js";
import { ensureBackgroundWorkerStarted } from "../lib/importer/jobs/backgroundWorker.server.js";

const appUrl =
  process.env.SHOPIFY_APP_URL ||
  process.env.APP_URL ||
  process.env.HOST ||
  "";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: (
    process.env.SCOPES ||
    "read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,read_customers,write_customers,read_publications,write_publications"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  appUrl,
  authPathPrefix: "/auth",
  sessionStorage: resolveSessionStorage(),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

ensureBackgroundWorkerStarted();
