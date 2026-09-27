import { describe, expect, it } from "vitest";
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
    expect(result.matches[0].reasons[0]).toMatch(/^Delivery address matched/);
    expect(result.matches[1].sections).toEqual(["geo"]);
    expect(result.bySection).toEqual({ geo: 1, address: 1, quantity: 0, vip: 0 });
  });
});
