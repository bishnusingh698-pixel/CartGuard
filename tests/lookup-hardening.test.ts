/**
 * Regression tests for lookups that index plain objects with values coming from
 * merchant-editable metafields or from the Admin API.
 */

import { describe, expect, it } from "vitest";
import { evaluateCart, normalizeCountry, resolveCountryCode, type RuleConfig } from "../extensions/cartguard-validator/src/rules";
import { simulateOrders } from "../app/lib/cartguard.server";

const HOSTILE_KEYS = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"];

describe("resolveCountryCode", () => {
  it("returns null rather than an inherited Object property", () => {
    for (const key of HOSTILE_KEYS) {
      expect(resolveCountryCode(key), key).toBeNull();
    }
  });

  it("always returns a string or null, never a function or object", () => {
    for (const value of [...HOSTILE_KEYS, "US", "Germany", "", "   ", 42, null, undefined, {}]) {
      const result = resolveCountryCode(value);
      expect(result === null || typeof result === "string", String(value)).toBe(true);
    }
  });

  it("normalizeCountry stays a plain uppercased string", () => {
    expect(normalizeCountry("__proto__")).toBe("__PROTO__");
    expect(normalizeCountry("constructor")).toBe("CONSTRUCTOR");
    expect(typeof normalizeCountry("valueOf")).toBe("string");
  });

  it("still resolves real codes, aliases and accented names", () => {
    expect(resolveCountryCode("us")).toBe("US");
    expect(resolveCountryCode("Germany")).toBe("DE");
    expect(resolveCountryCode("Deutschland")).toBe("DE");
    // Aliases are matched with diacritics stripped, so an accented spelling works.
    expect(resolveCountryCode("Brasil")).toBe("BR");
    expect(resolveCountryCode("Turkiye")).toBe("TR");
    // An alias that isn't in the table still resolves as a bare code.
    expect(resolveCountryCode("FR")).toBe("FR");
  });
});

describe("a country scope that resolves to nothing", () => {
  const config = (country: string): RuleConfig => ({
    settings: { enable_vip: true, enable_po_box: true, enable_quantity: true, enable_geo: true },
    regexRules: [{ pattern: "\\bpo\\s*box\\b", message: "no PO boxes", country }],
    quantityLimits: {},
    geoBlocklist: { countries: [], zips: [], cities: [], states: [] },
    vipAllowlist: [],
  });
  const cart = (countryCode: string) => ({
    email: null,
    customerEmail: null,
    currencyCode: "USD",
    totalAmount: null,
    lines: [],
    addresses: [{ groupIndex: 0, address: { address1: "PO Box 9", city: "Austin", countryCode } }],
  });

  it("fails closed instead of matching every country", () => {
    for (const hostile of HOSTILE_KEYS) {
      for (const cc of ["US", "CA", "DE"]) {
        expect(evaluateCart(cart(cc), config(hostile)), `${hostile}/${cc}`).toHaveLength(0);
      }
    }
  });
});

describe("order conversion with malformed product data", () => {
  const config: RuleConfig = {
    settings: { enable_vip: true, enable_po_box: true, enable_quantity: true, enable_geo: true },
    regexRules: [],
    quantityLimits: { bulk: { max: 1 } },
    geoBlocklist: { countries: [], zips: [], cities: [], states: [] },
    vipAllowlist: [],
  };
  const order = (tags: unknown, quantity = 5) => ({
    id: "gid://shopify/Order/1",
    name: "#1",
    lineItems: {
      nodes: [
        {
          quantity,
          product: { id: "gid://shopify/Product/1", tags },
          originalTotalSet: { shopMoney: { amount: "10.00" } },
        },
      ],
    },
  });

  it("does not throw when tags is not an array", () => {
    for (const tags of ["bulk", 42, {}, null, undefined, true]) {
      const result = simulateOrders([order(tags) as never], config);
      expect(result.scanned, String(tags)).toBe(1);
    }
  });

  it("still applies the tag limit when tags is a real array", () => {
    expect(simulateOrders([order(["Bulk"]) as never], config).blocked).toBe(1);
    expect(simulateOrders([order(["other"]) as never], config).blocked).toBe(0);
  });

  it("tolerates null line item collections", () => {
    for (const lineItems of [null, { nodes: null }, { nodes: [null] }, { nodes: [{ quantity: 1, product: null }] }]) {
      expect(simulateOrders([{ id: "gid://shopify/Order/1", lineItems } as never], config).scanned).toBe(1);
    }
  });
});