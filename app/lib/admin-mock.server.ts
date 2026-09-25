import type { AdminApi } from "./admin-api.server";

/**
 * Demo mode (in-memory admin with sample data) is only for local previews
 * outside the Shopify admin. It is never available in production: there, an
 * unauthenticated request must go through Shopify auth instead of silently
 * getting a fake store that reports "Rules saved and active at checkout".
 */
export function canUseMockAdmin(request: Request): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const url = new URL(request.url);
  const isEmbedded = url.searchParams.get("embedded") === "1" || Boolean(url.searchParams.get("host"));
  return !isEmbedded;
}

// In-memory metafields store for preview / demo standalone mode
const mockMetafieldsStore = new Map<string, string>([
  [
    "settings",
    JSON.stringify({
      enable_vip: true,
      enable_po_box: true,
      enable_quantity: true,
      enable_geo: false,
    }),
  ],
  [
    "regex_rules",
    JSON.stringify([
      {
        preset: "po_box",
        pattern:
          "(?:\\b(?:p[.\\-\\s]*o[.\\-\\s]*b(?:ox)?|post[.\\-\\s]*office[.\\-\\s]*box|apartado[.\\-\\s]*postal|postfach|boite[.\\-\\s]*postale|casilla[.\\-\\s]*postal)\\b|\\bpob\\s*\\d|\\bpost[.\\-\\s]*office[.\\-\\s]*box[.\\-\\s]*\\d)",
        message: "We cannot deliver to PO Boxes. Please provide a street address.",
      },
      {
        preset: "freight",
        pattern:
          "(?:\\bfreight\\s*forward|\\breship|\\bmail[.\\-\\s]*(?:drop|forwarding)|\\bpackage[.\\-\\s]*forwarding|\\bste[.\\-\\s]*[a-z0-9]+[.\\-\\s]*suite)",
        message: "We cannot ship to freight forwarders or reshippers.",
      },
    ]),
  ],
  [
    "quantity_limits",
    JSON.stringify({
      "limited-edition": { max: 5, message: "Limit 5 per order for limited-edition items." },
      "bulk": 10,
    }),
  ],
  [
    "geo_blocklist",
    JSON.stringify({
      countries: ["KZ", "CR"],
      zips: ["90210"],
      cities: [],
      states: [],
    }),
  ],
  [
    "vip_allowlist",
    JSON.stringify(["vip@customer.com", "123 Executive Blvd"]),
  ],
]);

const SAMPLE_ORDERS = [
  {
    id: "gid://shopify/Order/1021",
    name: "#1021",
    email: "customer1@example.com",
    shippingAddress: {
      address1: "P.O. Box 842",
      address2: "",
      city: "Austin",
      provinceCode: "TX",
      zip: "78701",
      countryCode: "US",
    },
    lineItems: {
      nodes: [
        {
          quantity: 1,
          product: { id: "gid://shopify/Product/101", tags: ["apparel"] },
        },
      ],
    },
  },
  {
    id: "gid://shopify/Order/1022",
    name: "#1022",
    email: "buyer2@example.com",
    shippingAddress: {
      address1: "Suite 400 Freight Forwarder Hub",
      address2: "",
      city: "Miami",
      provinceCode: "FL",
      zip: "33126",
      countryCode: "US",
    },
    lineItems: {
      nodes: [
        {
          quantity: 2,
          product: { id: "gid://shopify/Product/102", tags: ["gadget"] },
        },
      ],
    },
  },
  {
    id: "gid://shopify/Order/1023",
    name: "#1023",
    email: "user3@example.com",
    shippingAddress: {
      address1: "Calle 5, Avenida Central",
      address2: "",
      city: "San José",
      provinceCode: "SJ",
      zip: "10101",
      countryCode: "CR",
    },
    lineItems: {
      nodes: [
        {
          quantity: 1,
          product: { id: "gid://shopify/Product/103", tags: ["standard"] },
        },
      ],
    },
  },
  {
    id: "gid://shopify/Order/1024",
    name: "#1024",
    email: "soldier@example.mil",
    shippingAddress: {
      address1: "Unit 2050 Box 4190",
      address2: "",
      city: "APO",
      provinceCode: "AE",
      zip: "09128",
      countryCode: "US",
    },
    lineItems: {
      nodes: [
        {
          quantity: 1,
          product: { id: "gid://shopify/Product/104", tags: ["books"] },
        },
      ],
    },
  },
  {
    id: "gid://shopify/Order/1025",
    name: "#1025",
    email: "collector@example.com",
    shippingAddress: {
      address1: "100 Universal City Plaza",
      address2: "",
      city: "Universal City",
      provinceCode: "CA",
      zip: "91608",
      countryCode: "US",
    },
    lineItems: {
      nodes: [
        {
          quantity: 8,
          product: { id: "gid://shopify/Product/105", tags: ["limited-edition"] },
        },
      ],
    },
  },
  {
    id: "gid://shopify/Order/1026",
    name: "#1026",
    email: "vip@customer.com",
    shippingAddress: {
      address1: "P.O. Box 12",
      address2: "",
      city: "New York",
      provinceCode: "NY",
      zip: "10001",
      countryCode: "US",
    },
    lineItems: {
      nodes: [
        {
          quantity: 1,
          product: { id: "gid://shopify/Product/106", tags: ["luxury"] },
        },
      ],
    },
  },
  {
    id: "gid://shopify/Order/1027",
    name: "#1027",
    email: "homer@example.com",
    shippingAddress: {
      address1: "742 Evergreen Terrace",
      address2: "",
      city: "Springfield",
      provinceCode: "OR",
      zip: "97477",
      countryCode: "US",
    },
    lineItems: {
      nodes: [
        {
          quantity: 2,
          product: { id: "gid://shopify/Product/107", tags: ["standard"] },
        },
      ],
    },
  },
  {
    id: "gid://shopify/Order/1028",
    name: "#1028",
    email: "sherlock@example.co.uk",
    shippingAddress: {
      address1: "221B Baker Street",
      address2: "",
      city: "London",
      provinceCode: "",
      zip: "NW1 6XE",
      countryCode: "GB",
    },
    lineItems: {
      nodes: [
        {
          quantity: 1,
          product: { id: "gid://shopify/Product/108", tags: ["vintage"] },
        },
      ],
    },
  },
];

export function createMockAdmin(): AdminApi {
  return {
    async graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response> {
      const q = query.trim();
      const vars = options?.variables || {};

      // 1. CartGuardSettings
      if (q.includes("CartGuardSettings")) {
        const nodes = Array.from(mockMetafieldsStore.entries()).map(([key, value]) => ({
          key,
          value,
        }));
        const body = {
          data: {
            shop: {
              id: "gid://shopify/Shop/cartguard-demo-shop",
              current: { nodes },
              legacy: { nodes: [] },
            },
          },
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 2. CartGuardValidationState
      if (q.includes("CartGuardValidationState")) {
        const body = {
          data: {
            shopifyFunctions: {
              nodes: [
                {
                  id: "gid://shopify/ShopifyFunction/cartguard-validator",
                  title: "CartGuard Validator",
                  apiType: "validation",
                  appKey: process.env.SHOPIFY_API_KEY || "cartguard-dev-api-key",
                },
              ],
            },
            validations: {
              nodes: [
                {
                  id: "gid://shopify/Validation/cartguard-validation-1",
                  enabled: true,
                  blockOnFailure: false,
                  shopifyFunction: {
                    id: "gid://shopify/ShopifyFunction/cartguard-validator",
                  },
                },
              ],
            },
          },
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 3. CartGuardMetafieldsSet
      if (q.includes("CartGuardMetafieldsSet")) {
        const metafields = (vars.metafields as Array<{ key: string; value: string }>) || [];
        for (const mf of metafields) {
          if (mf.key && mf.value) {
            mockMetafieldsStore.set(mf.key, mf.value);
          }
        }
        const body = {
          data: {
            metafieldsSet: {
              metafields: metafields.map((m) => ({ key: m.key })),
              userErrors: [],
            },
          },
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 4. CartGuardRecentOrders
      if (q.includes("CartGuardRecentOrders")) {
        const body = {
          data: {
            orders: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: SAMPLE_ORDERS,
            },
          },
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 5. Validation mutations
      if (q.includes("CartGuardValidationCreate")) {
        const body = {
          data: {
            validationCreate: {
              validation: { id: "gid://shopify/Validation/cartguard-validation-1" },
              userErrors: [],
            },
          },
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (q.includes("CartGuardValidationUpdate")) {
        const body = {
          data: {
            validationUpdate: {
              validation: {
                id: (vars.id as string) || "gid://shopify/Validation/cartguard-validation-1",
                enabled: true,
                blockOnFailure: false,
              },
              userErrors: [],
            },
          },
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 6. Delete legacy
      if (q.includes("CartGuardDeleteLegacy")) {
        const body = {
          data: {
            metafieldsDelete: {
              deletedMetafields: [],
              userErrors: [],
            },
          },
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Fallback
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}
