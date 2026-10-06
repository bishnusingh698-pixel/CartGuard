import { describe, expect, it } from "vitest";
import { simulateOrders } from "../app/lib/cartguard.server";
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
