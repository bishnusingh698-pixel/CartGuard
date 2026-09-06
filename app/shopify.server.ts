import "@shopify/shopify-app-remix/adapters/node";
import {
  AppDistribution,
  shopifyApp,
  LATEST_API_VERSION,
} from "@shopify/shopify-app-remix/server";
import type { ApiVersion } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/**
 * Webhook registration note (architecture constraint #7):
 * Webhooks are declared declaratively in shopify.app.toml
 * ([[webhooks.subscriptions]] → app/uninstalled → /webhooks) and pushed on
 * `shopify app deploy` thanks to `include_config_on_deploy = true`. No
 * `hooks.afterAuth` / `registerWebhooks` plumbing lives here — the runtime
 * handler is app/routes/webhooks.tsx.
 */
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY || "a94fb70b5b04fc8e18e80b1663eae59a",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "cartguard-preview-secret",
  // Constraint #1: pin the 2026-07 (Summer 2026) API version. The installed
  // copy of shopify-app-remix type-declares an older ApiVersion union, so the
  // literal is asserted; the runtime accepts the version string as-is.
  apiVersion: "2026-07" as ApiVersion,
  scopes: process.env.SCOPES ? process.env.SCOPES.split(",") : ["read_products", "read_orders", "write_metafields"],
  appUrl: process.env.SHOPIFY_APP_URL || "https://cartguard.netlify.app",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // NOTE: no `future` flags and no `hooks.afterAuth` webhook registration —
  // webhooks are declared in shopify.app.toml (constraint #7) and the v3
  // library line applies those behaviours by default.
});

const inMemoryMetafields: Record<string, string> = {
  settings: JSON.stringify({
    enable_vip: true,
    enable_po_box: true,
    enable_quantity: true,
    enable_geo: true,
    enable_mismatch: false,
  }),
  regex_rules: JSON.stringify([
    {
      pattern: "p\\.?o\\.? box|post office box",
      message: "We are unable to deliver to PO Boxes. Please provide a street address.",
    },
    {
      pattern: "freight forwarder|forwarding (company|agent)|reship",
      message: "We are unable to deliver to freight forwarders.",
    },
  ]),
  quantity_limits: JSON.stringify({
    bulk: 10,
    reseller: 25,
  }),
  geo_blocklist: JSON.stringify({
    zips: ["90210", "10001"],
    cities: ["Faketown"],
    states: ["XX"],
  }),
  vip_allowlist: JSON.stringify(["vip@yourstore.com", "wholesale@partner.io"]),
};

const mockAdminApi = {
  graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
    if (query.includes("CartGuardSettings")) {
      const nodes = Object.entries(inMemoryMetafields).map(([key, value]) => ({ key, value }));
      return new Response(
        JSON.stringify({
          data: {
            shop: {
              metafields: { nodes },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("CartGuardShopContext")) {
      return new Response(
        JSON.stringify({
          data: {
            shop: { id: "gid://shopify/Shop/100000001" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("CartGuardSave")) {
      const metafields = options?.variables?.metafields as
        | Array<{ key: string; value: string }>
        | undefined;
      if (metafields) {
        for (const mf of metafields) {
          inMemoryMetafields[mf.key] = mf.value;
        }
      }
      return new Response(
        JSON.stringify({
          data: {
            metafieldsSet: {
              userErrors: [],
              metafields:
                metafields?.map((m) => ({
                  id: `gid://shopify/Metafield/${m.key}`,
                  key: m.key,
                })) || [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("CartGuardLastOrders")) {
      const mockOrders = [
        {
          id: "gid://shopify/Order/1001",
          name: "#1001",
          createdAt: "2026-09-01T10:00:00Z",
          email: "customer1@example.com",
          shippingAddress: {
            address1: "123 Main St",
            city: "New York",
            provinceCode: "NY",
            zip: "10001",
          },
          billingAddress: {
            address1: "123 Main St",
            city: "New York",
            provinceCode: "NY",
            zip: "10001",
          },
          lineItems: {
            nodes: [
              {
                quantity: 2,
                variant: { product: { id: "gid://shopify/Product/1", tags: ["standard"] } },
              },
            ],
          },
        },
        {
          id: "gid://shopify/Order/1002",
          name: "#1002",
          createdAt: "2026-09-02T11:00:00Z",
          email: "buyer2@gmail.com",
          shippingAddress: {
            address1: "P.O. Box 452",
            city: "Austin",
            provinceCode: "TX",
            zip: "78701",
          },
          billingAddress: {
            address1: "P.O. Box 452",
            city: "Austin",
            provinceCode: "TX",
            zip: "78701",
          },
          lineItems: {
            nodes: [
              {
                quantity: 1,
                variant: { product: { id: "gid://shopify/Product/2", tags: ["gadget"] } },
              },
            ],
          },
        },
        {
          id: "gid://shopify/Order/1003",
          name: "#1003",
          createdAt: "2026-09-03T12:00:00Z",
          email: "vip@yourstore.com",
          shippingAddress: {
            address1: "PO Box 999",
            city: "Beverly Hills",
            provinceCode: "CA",
            zip: "90210",
          },
          billingAddress: {
            address1: "PO Box 999",
            city: "Beverly Hills",
            provinceCode: "CA",
            zip: "90210",
          },
          lineItems: {
            nodes: [
              {
                quantity: 15,
                variant: { product: { id: "gid://shopify/Product/3", tags: ["bulk"] } },
              },
            ],
          },
        },
        {
          id: "gid://shopify/Order/1004",
          name: "#1004",
          createdAt: "2026-09-04T14:00:00Z",
          email: "wholesale.buyer@distributor.net",
          shippingAddress: {
            address1: "45 Industrial Blvd",
            city: "Chicago",
            provinceCode: "IL",
            zip: "60601",
          },
          billingAddress: {
            address1: "45 Industrial Blvd",
            city: "Chicago",
            provinceCode: "IL",
            zip: "60601",
          },
          lineItems: {
            nodes: [
              {
                quantity: 30,
                variant: { product: { id: "gid://shopify/Product/3", tags: ["bulk"] } },
              },
            ],
          },
        },
        {
          id: "gid://shopify/Order/1005",
          name: "#1005",
          createdAt: "2026-09-05T08:00:00Z",
          email: "reshipper@freightforwarding.com",
          shippingAddress: {
            address1: "Suite 400 Freight Forwarder Hub",
            city: "Miami",
            provinceCode: "FL",
            zip: "33101",
          },
          billingAddress: {
            address1: "12 Pine St",
            city: "Seattle",
            provinceCode: "WA",
            zip: "98101",
          },
          lineItems: {
            nodes: [
              {
                quantity: 1,
                variant: { product: { id: "gid://shopify/Product/4", tags: ["electronics"] } },
              },
            ],
          },
        },
      ];

      return new Response(
        JSON.stringify({
          data: {
            orders: {
              nodes: mockOrders,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};

const customAuthenticate = {
  ...shopify.authenticate,
  admin: async (request: Request) => {
    try {
      return await shopify.authenticate.admin(request);
    } catch (error) {
      // If shopify authentication throws a Response (e.g., OAuth redirect or 401), we MUST throw it so Remix executes the redirect!
      if (error instanceof Response) {
        throw error;
      }
      // If we are in local preview mode without credentials, fall back to mock
      if (!process.env.SHOPIFY_API_KEY && !process.env.SHOPIFY_API_SECRET) {
        return {
          admin: mockAdminApi,
          session: {
            shop: "cartguard-preview.myshopify.com",
            accessToken: "mock-token",
            isOnline: false,
          },
        } as unknown as Awaited<ReturnType<typeof shopify.authenticate.admin>>;
      }
      throw error;
    }
  },
};

export default shopify;
export const apiVersion = LATEST_API_VERSION;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = customAuthenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;
