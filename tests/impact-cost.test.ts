import { describe, expect, it } from "vitest";
import { simulateImpact, simulateOrders } from "../app/lib/cartguard.server";
import { parseConfig } from "../extensions/cartguard-validator/src/rules";

const config = parseConfig({
  settings: JSON.stringify({ enable_quantity: true }),
  quantity_limits: JSON.stringify({ all: { maxAmount: 100 } }),
});

const order = (subtotal: string | null, lineTotal: string) => ({
  id: "gid://shopify/Order/1",
  name: "#1001",
  currencyCode: "USD",
  subtotalPriceSet: subtotal === null ? null : { shopMoney: { amount: subtotal } },
  lineItems: {
    nodes: [{ quantity: 1, originalTotalSet: { shopMoney: { amount: lineTotal } }, product: { id: "gid://shopify/Product/1", tags: [] } }],
  },
});

describe("Impact Checker order totals", () => {
  it("uses the order subtotal, which covers lines beyond the ones fetched", () => {
    expect(simulateOrders([order("150.00", "50.00")], config).blocked).toBe(1);
    expect(simulateOrders([order("90.00", "150.00")], config).blocked).toBe(0);
  });

  it("falls back to line prices when the subtotal is missing", () => {
    expect(simulateOrders([order(null, "150.00")], config).blocked).toBe(1);
    expect(simulateOrders([order("", "50.00")], config).blocked).toBe(0);
  });
});

describe("Impact Checker without protected customer data", () => {
  const page = {
    data: {
      orders: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [order("150.00", "150.00")],
      },
    },
  };
  const adminRefusing = (message: string) => {
    const queries: string[] = [];
    return {
      queries,
      graphql: async (query: string) => {
        queries.push(query);
        const body = /\bemail\b/.test(query) ? { errors: [{ message }] } : page;
        return new Response(JSON.stringify(body));
      },
    };
  };

  it("retries without emails and addresses and says so", async () => {
    const admin = adminRefusing("This app is not approved to use the email field. See https://shopify.dev/docs/apps/launch/protected-customer-data for more details.");
    const result = await simulateImpact(admin, config);
    expect(admin.queries).toHaveLength(2);
    expect(result.customerDataHidden).toBe(true);
    expect(result.blocked).toBe(1);
  });

  it("does not hide other errors", async () => {
    const admin = adminRefusing("Field 'foo' doesn't exist on type 'Order'");
    await expect(simulateImpact(admin, config)).rejects.toThrow(/doesn't exist/);
    expect(admin.queries).toHaveLength(1);
  });
});
