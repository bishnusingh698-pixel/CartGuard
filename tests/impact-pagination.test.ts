/**
 * Pagination behaviour of the Impact Checker.
 *
 * The scan loop is bounded by the number of orders collected, so any page that
 * returns rows but never advances the cursor used to keep querying until the
 * Admin API throttled. These tests pin the stop conditions.
 */

import { describe, expect, it } from "vitest";
import { simulateImpact, type RuleConfig } from "../app/lib/cartguard.server";

const config = {
  settings: { enable_vip: true, enable_po_box: true, enable_quantity: true, enable_geo: true },
  regexRules: [],
  quantityLimits: {},
  geoBlocklist: { countries: [], zips: [], cities: [], states: [] },
  vipAllowlist: [],
} as unknown as RuleConfig;

const orderNode = (id: string) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  email: "a@b.com",
  currencyCode: "USD",
  shippingAddress: { address1: "1 Main", city: "Austin", provinceCode: "TX", zip: "78701", countryCode: "US" },
  lineItems: {
    nodes: [
      { quantity: 1, originalTotalSet: { shopMoney: { amount: "10.00" } }, product: { id: "gid://shopify/Product/1", tags: [] } },
    ],
  },
});

const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null, currentlyAvailable = 900) => ({
  data: { orders: { pageInfo: { hasNextPage, endCursor }, nodes } },
  extensions: { cost: { throttleStatus: { currentlyAvailable } } },
});

/** Stands in for the Shopify Admin client, which returns a JSON Response. */
const makeAdmin = (bodies: Array<{ data: unknown; extensions?: unknown }>) => {
  let call = 0;
  const cursors: Array<string | null> = [];
  const admin = {
    graphql: async (_query: string, variables: { after?: string | null }) => {
      cursors.push(variables?.after ?? null);
      const body = bodies[call++];
      if (!body) throw new Error("pagination kept querying past the supplied pages");
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return { admin: admin as never, cursors };
};

describe("simulateImpact pagination", () => {
  it("stops when the API repeats the same cursor", async () => {
    const { admin, cursors } = makeAdmin(Array.from({ length: 40 }, () => page([], true, "SAME")));
    const result = await simulateImpact(admin, config);
    expect(result.scanned).toBe(0);
    expect(cursors.length).toBe(1);
  });

  it("stops when a page claims another page but returns no orders", async () => {
    const { admin, cursors } = makeAdmin(Array.from({ length: 20 }, () => page([], true, "next")));
    await simulateImpact(admin, config);
    expect(cursors.length).toBe(1);
  });

  it("stops when hasNextPage is true but there is no cursor", async () => {
    const { admin, cursors } = makeAdmin([page([], true, null)]);
    await simulateImpact(admin, config);
    expect(cursors.length).toBe(1);
  });

  it("follows distinct cursors until the order cap", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      page(Array.from({ length: 10 }, (_, j) => orderNode(String(i * 10 + j))), true, `cursor-${i}`),
    );
    const { admin } = makeAdmin(many);
    const result = await simulateImpact(admin, config);
    expect(result.scanned).toBe(100);
  });

  it("stops paginating when the throttle budget runs low", async () => {
    const { admin, cursors } = makeAdmin([
      page([orderNode("1")], true, "c1", 100),
      page([orderNode("2")], true, "c2"),
    ]);
    const result = await simulateImpact(admin, config);
    expect(result.scanned).toBe(1);
    expect(cursors.length).toBe(1);
  });

  it("tolerates an absent orders node", async () => {
    const nullOrders = makeAdmin([{ data: { orders: null } }]);
    await expect(simulateImpact(nullOrders.admin, config)).resolves.toMatchObject({ scanned: 0 });

    const nullNodes = makeAdmin([{ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: null } } }]);
    await expect(simulateImpact(nullNodes.admin, config)).resolves.toMatchObject({ scanned: 0 });
  });
});