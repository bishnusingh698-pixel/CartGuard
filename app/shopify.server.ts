import "@shopify/shopify-app-remix/adapters/node";
import { AppDistribution, shopifyApp, type ApiVersion } from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/**
 * Webhooks are declared in shopify.app.toml and pushed on `shopify app deploy`
 * (include_config_on_deploy = true). The runtime handler is
 * app/routes/webhooks.tsx.
 */

function getEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

/** Pinned Admin API version. Keep in sync with shopify.app.toml and the Function. */
export const API_VERSION = "2026-07" as ApiVersion;

// Passed as a variable so flags the installed library version doesn't know
// about can't break type-checking.
const futureFlags = {
  unstable_newEmbeddedAuthStrategy: true,
};

const shopify = shopifyApp({
  apiKey: getEnv("SHOPIFY_API_KEY", "cartguard-dev-api-key"),
  apiSecretKey: getEnv("SHOPIFY_API_SECRET", "cartguard-dev-api-secret"),
  apiVersion: API_VERSION,
  scopes: process.env.SCOPES?.split(",").map((scope) => scope.trim()).filter(Boolean) ?? ["read_orders", "write_validations"],
  appUrl: getEnv("SHOPIFY_APP_URL", "http://localhost:3000"),
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: futureFlags,
});

export default shopify;
export const apiVersion = API_VERSION;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;
