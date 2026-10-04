import { describe, expect, it } from "vitest";
import { detailText } from "./helpers/message";
import { ADDRESS_PRESETS, type RuleConfig } from "../extensions/cartguard-validator/src/rules";
import { simulateOrders } from "../app/lib/cartguard.server";

const rules: RuleConfig = {
  settings: { enable_vip: false, enable_po_box: true, enable_quantity: false, enable_geo: true },
  regexRules: [{ preset: "po_box", pattern: ADDRESS_PRESETS.po_box.pattern, message: ADDRESS_PRESETS.po_box.message }],
  quantityLimits: {},
  geoBlocklist: { countries: ["KZ"], zips: [], cities: [], states: [] },
  vipAllowlist: [],
};

describe("order check", () => {
  it("lists every stopped order with a plain reason and where it ships", () => {
    const result = simulateOrders(
      [
        {
          id: "gid://shopify/Order/1001",
          name: "#1001",
          shippingAddress: { address1: "PO Box 9", city: "Austin", provinceCode: "TX", countryCode: "US" },
          lineItems: { nodes: [] },
        },
        {
          id: "gid://shopify/Order/1002",
          name: "#1002",
          shippingAddress: { address1: "Abay Avenue 45", city: "Almaty", countryCode: "KZ" },
          lineItems: { nodes: [] },
        },
        {
          id: "gid://shopify/Order/1003",
          name: "#1003",
          shippingAddress: { address1: "1 Main St", city: "Austin", countryCode: "US" },
          lineItems: { nodes: [] },
        },
      ],
      rules,
    );
    expect(result.scanned).toBe(3);
    expect(result.blocked).toBe(2);
    expect(result.matches[0]).toMatchObject({
      orderId: "1001",
      name: "#1001",
      shipTo: "Austin, TX, United States",
      sections: ["address"],
    });
    expect(detailText(result.matches[0].reasons[0])).toMatch(/^Delivery address matched/);
    expect(result.matches[1].sections).toEqual(["geo"]);
    expect(result.bySection).toEqual({ geo: 1, address: 1, quantity: 0, vip: 0 });
  });
});

describe("order check with amount limits", () => {
  it("reports the orders the total would have stopped", () => {
    const result = simulateOrders(
      [
        {
          id: "gid://shopify/Order/2001",
          name: "#2001",
          currencyCode: "USD",
          shippingAddress: { address1: "1 Main St", countryCode: "US" },
          lineItems: {
            nodes: [{ quantity: 3, originalTotalSet: { shopMoney: { amount: "600.00" } }, product: { id: "gid://shopify/Product/1", tags: [] } }],
          },
        },
        {
          id: "gid://shopify/Order/2002",
          name: "#2002",
          currencyCode: "USD",
          shippingAddress: { address1: "2 Main St", countryCode: "US" },
          lineItems: {
            nodes: [{ quantity: 1, originalTotalSet: { shopMoney: { amount: "20.00" } }, product: { id: "gid://shopify/Product/2", tags: [] } }],
          },
        },
      ],
      {
        ...rules,
        settings: { ...rules.settings, enable_quantity: true },
        quantityLimits: { all: { minAmount: 50, maxAmount: 500 } },
      },
    );
    expect(result.blocked).toBe(2);
    expect(result.bySection.quantity).toBe(2);
    expect(detailText(result.matches[0].reasons[0])).toMatch(/above the maximum/);
    expect(detailText(result.matches[1].reasons[0])).toMatch(/below the minimum/);
  });
});
