/**
 * Phase 4: adversarial input and resilience.
 *
 * Every case here is something a buyer, a malicious app, or a broken store
 * could send. The rule engine runs inside a Shopify Function with an
 * instruction budget, so the properties that matter are: it never throws, it
 * never blocks because of hostile input, and a hostile pattern cannot make it
 * hang.
 */

import { describe, expect, it } from "vitest";
import { detailText } from "./helpers/message";
import {
  ADDRESS_PRESETS,
  MAX_FIELD_LENGTH,
  evaluateCart,
  isRiskyPattern,
  parseConfig,
  resolveCountryCode,
  type CartAddress,
  type CartInput,
  type RegexRule,
  type RuleConfig,
} from "../extensions/cartguard-validator/src/rules";
import { parseConfig as parseAppConfig, simulateOrders, validateRuleConfig } from "../app/lib/cartguard.server";

const ALL_ON = { enable_vip: true, enable_po_box: true, enable_quantity: true, enable_geo: true };

function config(overrides: Partial<RuleConfig> = {}): RuleConfig {
  return {
    settings: { ...ALL_ON },
    regexRules: [],
    quantityLimits: {},
    geoBlocklist: { countries: [], zips: [], cities: [], states: [] },
    vipAllowlist: [],
    ...overrides,
  };
}

const poBox: RegexRule = { preset: "po_box", pattern: ADDRESS_PRESETS.po_box.pattern, message: "no PO boxes" };

function cartAt(address: CartAddress, extra: Partial<CartInput> = {}): CartInput {
  return { email: null, lines: [], addresses: [{ groupIndex: 0, address }], ...extra };
}

describe("hostile address text", () => {
  it("does not throw on pathological length or character sets", () => {
    const nasty: Array<[string, string]> = [
      ["a".repeat(50_000), "long ASCII"],
      ["PO Box 1".repeat(2_000), "repeated keyword"],
      ["\u0000\u0001\u0002".repeat(500), "control characters"],
      ["\ud800".repeat(200), "lone surrogates"],
      ["🏠".repeat(300), "astral plane"],
      ["\\".repeat(400), "backslashes"],
      ["<script>alert(1)</script>", "markup"],
    ];
    for (const [address1, label] of nasty) {
      expect(() => evaluateCart(cartAt({ address1, countryCode: "US" }), config({ regexRules: [poBox] })), label).not.toThrow();
    }
  });

  it("caps the matched field length so a huge address cannot exceed the budget", () => {
    const huge = `PO Box 1 ${"x".repeat(200_000)}`;
    const v = evaluateCart(cartAt({ address1: huge, countryCode: "US" }), config({ regexRules: [poBox] }));
    // Detection still happens on the prefix, and nothing hangs doing it.
    expect(v.map((x) => x.rule)).toContain("address");
  });

  it("treats every non-string field type as empty rather than throwing", () => {
    for (const value of [null, undefined, 0, 1, true, false, {}, []]) {
      expect(() =>
        evaluateCart(cartAt({ address1: value as never, city: value as never, zip: value as never }), config({ regexRules: [poBox] })),
      ).not.toThrow();
    }
  });

  it("handles a cart with no addresses and no lines", () => {
    const empty: CartInput = { email: null, lines: [], addresses: [] };
    expect(evaluateCart(empty, config({ regexRules: [poBox] }))).toHaveLength(0);
  });

  it("does not let a blocked word hide by splitting across fields", () => {
    // "PO" in line 1 and "Box" in line 2 is the classic cross-field evasion.
    const v = evaluateCart(cartAt({ address1: "PO", address2: "Box 12", countryCode: "US" }), config({ regexRules: [poBox] }));
    expect(v.map((x) => x.rule)).toContain("address");
  });
});

describe("hostile rule patterns", () => {
  const withPattern = (pattern: string) => config({ regexRules: [{ pattern }] });

  it("skips an uncompilable pattern instead of throwing", () => {
    for (const pattern of ["(", "[a-", "*", "(?<", "\\p{Foo}", "a{2,1}"]) {
      expect(() => evaluateCart(cartAt({ address1: "1 Main", countryCode: "US" }), withPattern(pattern)), pattern).not.toThrow();
    }
  });

  it("skips an over-long pattern", () => {
    expect(evaluateCart(cartAt({ address1: "PO Box 1", countryCode: "US" }), withPattern("a".repeat(5_000)))).toHaveLength(0);
  });

  it("flags catastrophic-backtracking patterns as risky", () => {
    for (const pattern of ["(a+)+$", "(a|a)+$", "(\\w+\\s?)*", "(x+x+)+y", "(a+)*b"]) {
      expect(isRiskyPattern(pattern), pattern).toBe(true);
    }
  });

  it("does not flag ordinary patterns as risky", () => {
    for (const pattern of ["po ?box", "\\b(apo|fpo|dpo)\\b", "post\\s+office", "^main.*street$"]) {
      expect(isRiskyPattern(pattern), pattern).toBe(false);
    }
  });

  it("rejects a risky pattern in merchant input", () => {
    // The admin posts camelCase keys; the metafields use snake_case. Both paths
    // must refuse a catastrophic pattern.
    const { config: parsed, errors } = validateRuleConfig({
      settings: ALL_ON,
      regexRules: [{ pattern: "(a+)+$", message: "x" }],
    });
    expect(parsed === null || Object.keys(errors).length > 0).toBe(true);
    expect(errors.address ? detailText(errors.address) : "").toMatch(/slow down checkout/i);
  });

  it("never evaluates a risky pattern that arrived from outside the admin", () => {
    // parseRegexRules is the choke point for the Function, so a hand-edited
    // metafield carrying "(a+)+$" must be dropped before it can backtrack.
    const parsed = parseConfig({ regex_rules: JSON.stringify([{ pattern: "(a+)+$" }, { pattern: "po box" }]) });
    expect(parsed.regexRules).toHaveLength(1);
    expect(parsed.regexRules[0].pattern).toBe("po box");

    const started = Date.now();
    evaluateCart(cartAt({ address1: `${"a".repeat(60)}!`, countryCode: "US" }), parsed);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("hostile configuration payloads", () => {
  it("survives malformed JSON in every metafield", () => {
    for (const raw of ["{", "null", "[]", '{"a":', "undefined", "\u0000", "0", '""', '"[object Object]"']) {
      expect(() => parseConfig({ settings: raw, regex_rules: raw, quantity_limits: raw, geo_blocklist: raw, vip_allowlist: raw }), raw).not.toThrow();
    }
  });

  it("survives structurally wrong values", () => {
    const cfg = parseConfig({
      settings: '{"enable_po_box":"yes"}',
      regex_rules: '{"preset":"po_box"}',
      quantity_limits: '{"all":{"max":"lots"}}',
      geo_blocklist: '{"countries":"CU"}',
      vip_allowlist: '{"not":"a list"}',
    });
    expect(() => evaluateCart(cartAt({ address1: "PO Box 1", countryCode: "US" }), cfg)).not.toThrow();
  });

  it("ignores prototype-polluting keys", () => {
    expect(() =>
      parseConfig({
        regex_rules: '[{"pattern":"po box","__proto__":{"polluted":true}}]',
        vip_allowlist: '["constructor","__proto__"]',
      }),
    ).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never resolves a country name to an Object.prototype member", () => {
    // Bare index access would hand back the Object constructor instead of
    // null, so resolveCountryCode is tested directly for the pollution keys.
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(resolveCountryCode(key), key).toBeNull();
    }
  });

  it("ignores a garbage country entry rather than blocking on a guess", () => {
    // "constructor" is not a country. normalizeCountry uppercases it, so the
    // blocklist entry and the address agree only on literal nonsense, and a
    // real address can never be hit by it.
    const polluted = config({ geoBlocklist: { countries: ["constructor"], zips: [], cities: [], states: [] } });
    expect(evaluateCart(cartAt({ address1: "1 Main", countryCode: "US" }), polluted)).toHaveLength(0);
    expect(evaluateCart(cartAt({ address1: "1 Main", countryCode: "CA" }), polluted)).toHaveLength(0);
  });
});

describe("resilience when the platform misbehaves", () => {
  it("blocks nothing rather than throwing when a rule step explodes", () => {
    // A rule object with a getter that throws simulates a broken config.
    const explosive = {
      get pattern(): string {
        throw new Error("boom");
      },
    } as unknown as RegexRule;
    expect(() => evaluateCart(cartAt({ address1: "1 Main", countryCode: "US" }), config({ regexRules: [explosive] }))).not.toThrow();
  });

  it("never blocks on an untrustworthy order total", () => {
    const limits = { all: { minAmount: 1_000_000 } };
    // No lines and no total: there is nothing to compare, so no violation.
    const noTotal: CartInput = { email: null, lines: [], addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }] };
    expect(evaluateCart(noTotal, config({ quantityLimits: limits }))).toHaveLength(0);
  });

  it("ignores non-numeric and negative quantities", () => {
    const limits = { all: { min: 5 } };
    const bad = (quantity: number): CartInput => ({
      email: null,
      lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity, tags: [] }],
      addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }],
    });
    for (const quantity of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => evaluateCart(bad(quantity), config({ quantityLimits: limits })), String(quantity)).not.toThrow();
    }
  });

  it("keeps evaluating when one delivery group is malformed", () => {
    const cart: CartInput = {
      email: null,
      lines: [],
      addresses: [
        { groupIndex: 0, address: { address1: "PO Box 1", countryCode: "US" } },
        { groupIndex: 1, address: null as never },
      ],
    };
    expect(() => evaluateCart(cart, config({ regexRules: [poBox] }))).not.toThrow();
  });
});

describe("Impact Checker shares the enforcement engine", () => {
  it("agrees with checkout on every rule type", () => {
    // The simulator must use evaluateCart, so a divergence here is a bug.
    const cfg = parseAppConfig({
      settings: JSON.stringify(ALL_ON),
      regex_rules: JSON.stringify([{ pattern: ADDRESS_PRESETS.po_box.pattern, message: "no PO boxes", preset: "po_box" }]),
      quantity_limits: JSON.stringify({ all: { max: 1 } }),
      geo_blocklist: JSON.stringify({ countries: ["CU"], zips: [], cities: [], states: [] }),
      vip_allowlist: JSON.stringify([]),
    });
    const orders = [
      { id: "1", name: "#1", shippingAddress: { address1: "PO Box 1", countryCode: "US" }, lineItems: { nodes: [{ quantity: 1, product: { id: "p", tags: [] } }] } },
      { id: "2", name: "#2", shippingAddress: { address1: "1 Main", countryCode: "CU" }, lineItems: { nodes: [{ quantity: 1, product: { id: "p", tags: [] } }] } },
      { id: "3", name: "#3", shippingAddress: { address1: "1 Main", countryCode: "US" }, lineItems: { nodes: [{ quantity: 9, product: { id: "p", tags: [] } }] } },
      { id: "4", name: "#4", shippingAddress: { address1: "1 Main", countryCode: "US" }, lineItems: { nodes: [{ quantity: 1, product: { id: "p", tags: [] } }] } },
    ] as never[];
    const impact = simulateOrders(orders, cfg);
    expect(impact.blocked).toBe(3);
    expect(impact.scanned).toBe(4);
    expect(impact.matches.map((m) => m.name)).toEqual(["#1", "#2", "#3"]);
  });

  it("blocks nothing for a store with no orders", () => {
    const impact = simulateOrders([], parseAppConfig({}));
    expect(impact).toMatchObject({ scanned: 0, blocked: 0, matches: [], samples: [] });
  });

  it("does not crash on a very large order list", () => {
    const orders = Array.from({ length: 100_000 }, (_, i) => ({
      id: String(i),
      name: `#${i}`,
      shippingAddress: { address1: i % 2 ? "PO Box 1" : "1 Main", countryCode: "US" },
      lineItems: { nodes: [{ quantity: 1, product: { id: "p", tags: [] } }] },
    })) as never[];
    const cfg = parseAppConfig({
      settings: JSON.stringify({ enable_po_box: true }),
      regex_rules: JSON.stringify([{ pattern: ADDRESS_PRESETS.po_box.pattern }]),
    });
    const started = Date.now();
    const impact = simulateOrders(orders, cfg);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(impact.blocked).toBe(50_000);
  });
});

describe("field length cap is enforced", () => {
  it("caps address fields at MAX_FIELD_LENGTH before matching", () => {
    const started = Date.now();
    evaluateCart(cartAt({ address1: "PO Box 1" + "y".repeat(MAX_FIELD_LENGTH * 10), countryCode: "US" }), config({ regexRules: [poBox] }));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});