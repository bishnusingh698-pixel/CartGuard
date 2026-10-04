import { describe, expect, it } from "vitest";
import { detailText } from "./helpers/message";
import { run } from "../extensions/cartguard-validator/src/run";
import {
  ADDRESS_PRESETS,
  collectLimitTags,
  evaluateCart,
  parseConfig,
  type CartAddress,
  type CartInput,
  type RegexRule,
  type RuleConfig,
} from "../extensions/cartguard-validator/src/rules";
import { simulateOrders, validateRuleConfig } from "../app/lib/cartguard.server";

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

const poBox: RegexRule = { preset: "po_box", pattern: ADDRESS_PRESETS.po_box.pattern, message: ADDRESS_PRESETS.po_box.message };

function cartAt(address: CartAddress, extra: Partial<CartInput> = {}): CartInput {
  return { email: null, lines: [], addresses: [{ groupIndex: 0, address }], ...extra };
}

describe("address rules", () => {
  it("blocks PO Boxes", () => {
    for (const address1 of ["P.O. Box 452", "PO Box 9", "pobox 12", "Post Office Box 7"]) {
      const violations = evaluateCart(cartAt({ address1, countryCode: "US" }), config({ regexRules: [poBox] }));
      expect(violations, address1).toHaveLength(1);
      expect(violations[0].target).toBe("$.cart.deliveryGroups[0].deliveryAddress.address1");
    }
  });

  it("does not block look-alike streets or office suites", () => {
    const rules = config({ regexRules: [poBox] });
    expect(evaluateCart(cartAt({ address1: "12 Tempo Box Road", countryCode: "US" }), rules)).toHaveLength(0);
    expect(evaluateCart(cartAt({ address1: "1 Market St", address2: "Suite 400", countryCode: "US" }), rules)).toHaveLength(0);
  });

  it("no longer ships a freight forwarder preset", () => {
    expect(Object.keys(ADDRESS_PRESETS)).toEqual(["po_box", "military"]);
    // An address mentioning forwarding is only blocked when the merchant adds
    // their own rule for it.
    expect(evaluateCart(cartAt({ address1: "Suite 400 Freight Forwarder Hub", countryCode: "US" }), config())).toHaveLength(0);
  });

  it("applies country-scoped rules only in that country", () => {
    const rules = config({ regexRules: [{ pattern: "calle 5", country: "CR" }] });
    expect(evaluateCart(cartAt({ address1: "Calle 5", countryCode: "US" }), rules)).toHaveLength(0);
    expect(evaluateCart(cartAt({ address1: "Calle 5" }), rules)).toHaveLength(0);
    expect(evaluateCart(cartAt({ address1: "Calle 5", countryCode: "CR" }), rules)).toHaveLength(1);
  });

  it("skips invalid regex patterns without throwing", () => {
    const rules = config({ regexRules: [{ pattern: "(" }, poBox] });
    expect(evaluateCart(cartAt({ address1: "PO Box 1" }), rules)).toHaveLength(1);
  });
});

describe("VIP and country blocks", () => {
  const geo = { countries: ["KZ"], zips: [], cities: [], states: [] };

  it("lets signed-in VIPs skip address rules, but never guests typing a VIP email", () => {
    const rules = config({ regexRules: [poBox], vipAllowlist: ["VIP@Store.com"] });
    expect(evaluateCart(cartAt({ address1: "PO Box 1", countryCode: "US" }, { customerEmail: "vip@store.com" }), rules)).toHaveLength(0);
    expect(evaluateCart(cartAt({ address1: "PO Box 1", countryCode: "US" }, { email: "vip@store.com" }), rules)).toHaveLength(1);
  });

  it("never lets VIPs skip blocked countries", () => {
    const rules = config({ geoBlocklist: geo, vipAllowlist: ["vip@store.com"] });
    const violations = evaluateCart(cartAt({ address1: "Abay Avenue 45", countryCode: "KZ" }, { customerEmail: "vip@store.com" }), rules);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("country");
    expect(violations[0].target).toBe("$.cart.deliveryGroups[0].deliveryAddress.countryCode");
  });

  it("blocks ZIPs, cities and province codes", () => {
    const rules = config({ geoBlocklist: { countries: [], zips: ["90210"], cities: ["San José"], states: ["US-NY"] } });
    expect(evaluateCart(cartAt({ zip: "90 210", countryCode: "US" }), rules)[0]?.rule).toBe("zip");
    expect(evaluateCart(cartAt({ city: "san jose", countryCode: "CR" }), rules)[0]?.rule).toBe("city");
    expect(evaluateCart(cartAt({ provinceCode: "NY", countryCode: "US" }), rules)[0]?.rule).toBe("state");
  });
});

describe("quantity limits", () => {
  it("aggregates lines of the same product and matches tags case-insensitively", () => {
    const cart: CartInput = {
      email: null,
      addresses: [],
      lines: [
        { index: 0, productId: "gid://shopify/Product/1", quantity: 6, tags: ["Bulk"] },
        { index: 1, productId: "gid://shopify/Product/1", quantity: 6, tags: ["bulk"] },
      ],
    };
    const violations = evaluateCart(cart, config({ quantityLimits: { bulk: { max: 10 } } }));
    expect(violations).toHaveLength(1);
    expect(violations[0].target).toBe("$.cart.lines[0].quantity");
  });

  it("matches product IDs exactly, not by substring", () => {
    const limits = config({ quantityLimits: { "1": { max: 1 } } });
    const line = (id: string) => ({ email: null, addresses: [], lines: [{ index: 0, productId: id, quantity: 5, tags: [] }] });
    expect(evaluateCart(line("gid://shopify/Product/12"), limits)).toHaveLength(0);
    expect(evaluateCart(line("gid://shopify/Product/1"), limits)).toHaveLength(1);
  });

  it("enforces both ends of the range: min below, max above, neither inside", () => {
    // The merchant-facing promise is "between N and M per order", so both
    // bounds have to be enforced and an order inside the range has to pass.
    const limits = config({ quantityLimits: { "gid://shopify/Product/1": { min: 3, max: 10 } } });
    const order = (quantity: number) =>
      evaluateCart({ email: null, addresses: [], lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity, tags: [] }] }, limits);

    expect(order(2).map((v) => v.rule)).toEqual(["quantity"]);
    expect(order(11).map((v) => v.rule)).toEqual(["quantity"]);
    expect(order(3)).toHaveLength(0);
    expect(order(10)).toHaveLength(0);
  });

  it("enforces order totals through minAmount and maxAmount", () => {
    // Amount bounds are read off the cart total, which falls back to summing
    // `unitPrice` when Shopify sends no `totalAmount`.
    const withTotal = (unitPrice: number) =>
      evaluateCart({ email: null, addresses: [], lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity: 1, tags: [], unitPrice }] },
        config({ quantityLimits: { "gid://shopify/Product/1": { minAmount: 100, maxAmount: 500 } } }));

    expect(withTotal(50).map((v) => v.rule)).toEqual(["amount"]);
    expect(withTotal(900).map((v) => v.rule)).toEqual(["amount"]);
    expect(withTotal(250)).toHaveLength(0);
  });

  it("lets VIPs skip quantity and amount limits, but never a blocked country", () => {
    // A VIP is trusted to be a real customer ordering for themselves, so any
    // limit that exists purely to catch bulk abuse does not apply to them. The
    // country embargo is a different thing: it is a legal/geographic block,
    // not a fraud signal, so it holds for everyone including VIPs.
    const vip = "vip@store.com";
    const bust = { email: null, customerEmail: vip, addresses: [{ groupIndex: 0, address: { address1: "1 Market St", countryCode: "US" } }], lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity: 999, tags: [], unitPrice: 999 }] };

    const quantityOnly = config({ quantityLimits: { "gid://shopify/Product/1": { min: 5, max: 10, minAmount: 100, maxAmount: 500 } }, vipAllowlist: [vip] });
    expect(evaluateCart(bust, quantityOnly)).toHaveLength(0);

    const sameButNonVip = config({ quantityLimits: { "gid://shopify/Product/1": { min: 5, max: 10, minAmount: 100, maxAmount: 500 } } });
    expect(evaluateCart({ ...bust, customerEmail: "someone@store.com" }, sameButNonVip).length).toBeGreaterThan(0);

    const withEmbargo = config({
      geoBlocklist: { countries: ["KZ"], zips: [], cities: [], states: [] },
      quantityLimits: { "gid://shopify/Product/1": { max: 10 } },
      vipAllowlist: [vip],
    });
    const embargoed = evaluateCart({ ...bust, addresses: [{ groupIndex: 0, address: { address1: "Abay Avenue 45", countryCode: "KZ" } }] }, withEmbargo);
    expect(embargoed.map((v) => v.rule)).toEqual(["country"]);
  });

  it("only asks the Function about real tags", () => {
    const tags = collectLimitTags({ bulk: { max: 1 }, all: { max: 1 }, "gid://shopify/Product/5": { max: 1 }, "123": { max: 1 } });
    expect([...tags].sort()).toEqual(["123", "bulk"]);
  });
});

describe("Function entrypoint", () => {
  const input = {
    cart: {
      buyerIdentity: { email: "buyer@example.com" },
      lines: [
        {
          quantity: 12,
          merchandise: {
            __typename: "ProductVariant",
            product: { id: "gid://shopify/Product/1", hasTags: [{ tag: "bulk", hasTag: true }] },
          },
        },
      ],
      deliveryGroups: [
        { deliveryAddress: { address1: "P.O. Box 12", city: "Austin", provinceCode: "TX", zip: "78701", countryCode: "US" } },
      ],
    },
    shop: {
      settings: { value: JSON.stringify({ enable_po_box: true, enable_quantity: true }) },
      regex_rules: { value: JSON.stringify([poBox]) },
      quantity_limits: { value: JSON.stringify({ bulk: 10 }) },
      geo_blocklist: null,
      vip_allowlist: null,
    },
  };

  it("returns cart.validations.generate.run operations", () => {
    const result = run(input);
    const errors = result.operations[0].validationAdd.errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ target: "$.cart.lines[0].quantity" });
    expect(errors[1]).toMatchObject({ target: "$.cart.deliveryGroups[0].deliveryAddress.address1", message: ADDRESS_PRESETS.po_box.message });
  });

  it("is inert without settings and never throws on bad config", () => {
    expect(run({ ...input, shop: {} }).operations[0].validationAdd.errors).toHaveLength(0);
    const broken = { ...input, shop: { settings: { value: "{not json" }, regex_rules: { value: "[[[" } } };
    expect(run(broken).operations[0].validationAdd.errors).toHaveLength(0);
  });
});

describe("admin helpers", () => {
  const validRules = {
    settings: ALL_ON,
    regexRules: [poBox],
    quantityLimits: { bulk: 10 },
    geoBlocklist: { countries: ["Costa Rica"] },
    vipAllowlist: ["a@b.com"],
  };

  it("accepts valid rules and normalizes countries", () => {
    const { config: saved, errors } = validateRuleConfig(validRules);
    expect(errors).toEqual({});
    expect(saved?.geoBlocklist.countries).toEqual(["CR"]);
    expect(saved?.quantityLimits).toEqual({ bulk: { max: 10 } });
  });

  it("rejects invalid regex and unknown countries", () => {
    const { config: saved, errors } = validateRuleConfig({
      ...validRules,
      regexRules: [{ pattern: "(" }],
      geoBlocklist: { countries: ["Atlantis"] },
    });
    expect(saved).toBeNull();
    expect(errors.address).toBeTruthy();
    expect(errors.geo).toBeTruthy();
  });

  it("simulates orders with the same engine as checkout", () => {
    const orders = [
      {
        name: "#1001",
        email: "a@example.com",
        shippingAddress: { address1: "PO Box 999", countryCode: "US" },
        lineItems: { nodes: [{ quantity: 15, product: { id: "gid://shopify/Product/3", tags: ["bulk"] } }] },
      },
      {
        name: "#1002",
        email: "b@example.com",
        shippingAddress: { address1: "123 Main St", countryCode: "US" },
        lineItems: { nodes: [{ quantity: 1, product: { id: "gid://shopify/Product/4", tags: [] } }] },
      },
    ];
    const result = simulateOrders(orders, config({ regexRules: [poBox], quantityLimits: { bulk: { max: 10 } } }));
    expect(result.scanned).toBe(2);
    expect(result.blocked).toBe(1);
    expect(detailText(result.samples[0])).toContain("#1001");
  });
});

describe("exploit hardening", () => {
  const military: RegexRule = { preset: "military", pattern: ADDRESS_PRESETS.military.pattern, message: ADDRESS_PRESETS.military.message, country: "US" };

  it("a VIP street address only exempts address line 1", () => {
    const rules = config({ regexRules: [poBox], vipAllowlist: ["123 Executive Blvd"], quantityLimits: { all: { max: 1 } } });
    const cart = cartAt(
      { address1: "123 Executive Blvd", address2: "PO Box 5", countryCode: "US" },
      { lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity: 5, tags: [] }] },
    );
    const violations = evaluateCart(cart, rules);
    expect(violations.map((v) => v.rule).sort()).toEqual(["address", "quantity"]);
    expect(violations.find((v) => v.rule === "address")?.target).toBe("$.cart.deliveryGroups[0].deliveryAddress.address2");
  });

  it("sees through invisible characters, full-width letters and look-alike spellings", () => {
    for (const address1 of ["P\u200BO Box 12", "\uFF30\uFF2F \uFF22\uFF4F\uFF58 12", "P.0. Box 3", "POB 44"]) {
      expect(evaluateCart(cartAt({ address1, countryCode: "US" }), config({ regexRules: [poBox] })), address1).toHaveLength(1);
    }
  });

  it("does not match rules against province or country codes", () => {
    const rules = config({ regexRules: [{ pattern: "\\bca\\b" }] });
    expect(evaluateCart(cartAt({ address1: "1 Main St", provinceCode: "CA", countryCode: "CA" }), rules)).toHaveLength(0);
  });

  it("still catches military addresses by city", () => {
    const violations = evaluateCart(
      cartAt({ address1: "Unit 2050 Box 4190", city: "APO", provinceCode: "AE", countryCode: "US" }),
      config({ regexRules: [military] }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].target).toBe("$.cart.deliveryGroups[0].deliveryAddress.city");
  });

  it("scopes state and ZIP entries to their country", () => {
    const rules = config({ geoBlocklist: { countries: [], zips: ["US:10001"], cities: [], states: ["US-WA"] } });
    expect(evaluateCart(cartAt({ provinceCode: "WA", countryCode: "AU" }), rules)).toHaveLength(0);
    expect(evaluateCart(cartAt({ provinceCode: "WA", countryCode: "US" }), rules)[0]?.rule).toBe("state");
    expect(evaluateCart(cartAt({ zip: "10001", countryCode: "DE" }), rules)).toHaveLength(0);
    expect(evaluateCart(cartAt({ zip: "10001", countryCode: "US" }), rules)[0]?.rule).toBe("zip");
  });

  it("matches ZIP+4 codes and ignores punctuation in cities", () => {
    const rules = config({ geoBlocklist: { countries: [], zips: ["90210"], cities: ["St. John's"], states: [] } });
    expect(evaluateCart(cartAt({ zip: "90210-1234", countryCode: "US" }), rules)[0]?.rule).toBe("zip");
    expect(evaluateCart(cartAt({ city: "St Johns", countryCode: "CA" }), rules)[0]?.rule).toBe("city");
  });

  it("rejects patterns that could freeze checkout", () => {
    const { errors } = validateRuleConfig({ regexRules: [{ pattern: "(a+)+$" }] });
    expect(errors.address).toBeTruthy();
  });

  it("uses the signed-in customer's email in the Function, not the typed one", () => {
    const shop = {
      settings: { value: JSON.stringify({ enable_vip: true, enable_po_box: true }) },
      regex_rules: { value: JSON.stringify([poBox]) },
      vip_allowlist: { value: JSON.stringify(["vip@store.com"]) },
    };
    const deliveryGroups = [{ deliveryAddress: { address1: "PO Box 1", countryCode: "US" } }];
    const guest = run({ cart: { buyerIdentity: { email: "vip@store.com" }, lines: [], deliveryGroups }, shop });
    expect(guest.operations[0].validationAdd.errors).toHaveLength(1);
    const signedIn = run({
      cart: { buyerIdentity: { email: "vip@store.com", customer: { email: "vip@store.com" } }, lines: [], deliveryGroups },
      shop,
    });
    expect(signedIn.operations[0].validationAdd.errors).toHaveLength(0);
  });
});

describe("minimum and maximum limits", () => {
  const line = (quantity: number, unitPrice = 10) => ({
    email: null,
    addresses: [],
    lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity, tags: [], unitPrice }],
  });

  it("blocks orders under the minimum quantity", () => {
    const violations = evaluateCart(line(2), config({ quantityLimits: { all: { min: 3 } } }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "quantity", target: "$.cart.lines[0].quantity" });
    expect(violations[0].message).toMatch(/at least 3/);
    expect(evaluateCart(line(3), config({ quantityLimits: { all: { min: 3 } } }))).toHaveLength(0);
  });

  it("blocks orders over the maximum quantity and allows the boundary", () => {
    const rules = config({ quantityLimits: { all: { max: 5 } } });
    expect(evaluateCart(line(6), rules)).toHaveLength(1);
    expect(evaluateCart(line(5), rules)).toHaveLength(0);
  });

  it("applies a minimum and a maximum at the same time", () => {
    const rules = config({ quantityLimits: { all: { min: 2, max: 4 } } });
    expect(evaluateCart(line(1), rules)).toHaveLength(1);
    expect(evaluateCart(line(3), rules)).toHaveLength(0);
    expect(evaluateCart(line(5), rules)).toHaveLength(1);
  });

  it("aggregates the units of one product across variants before comparing", () => {
    const cart: CartInput = {
      email: null,
      addresses: [],
      lines: [
        { index: 0, productId: "gid://shopify/Product/1", quantity: 1, tags: [] },
        { index: 1, productId: "gid://shopify/Product/1", quantity: 1, tags: [] },
      ],
    };
    expect(evaluateCart(cart, config({ quantityLimits: { all: { min: 3 } } }))).toHaveLength(1);
  });

  it("blocks orders over the maximum order amount", () => {
    const violations = evaluateCart(line(1, 600), config({ quantityLimits: { all: { maxAmount: 500 } } }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "amount", target: "$.cart.cost.totalAmount" });
    expect(detailText(violations[0].detail)).toMatch(/\$600\.00/);
    expect(evaluateCart(line(1, 500), config({ quantityLimits: { all: { maxAmount: 500 } } }))).toHaveLength(0);
  });

  it("blocks orders under the minimum order amount", () => {
    const violations = evaluateCart(line(1, 20), config({ quantityLimits: { all: { minAmount: 50 } } }));
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("amount");
    expect(evaluateCart(line(1, 50), config({ quantityLimits: { all: { minAmount: 50 } } }))).toHaveLength(0);
  });

  it("prefers the cart total over summing line prices", () => {
    const cart = { ...line(1, 10), totalAmount: 900, currencyCode: "USD" };
    expect(evaluateCart(cart, config({ quantityLimits: { all: { maxAmount: 500 } } }))).toHaveLength(1);
  });

  it("uses the tightest amount bound when several limits set one", () => {
    // The product carries the `bulk` tag, so both limits apply to it and the
    // tighter one (100) has to win over the general 5000.
    const bulkLine = { email: null, addresses: [], lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity: 1, tags: ["bulk"], unitPrice: 300 }] };
    const rules = config({ quantityLimits: { all: { maxAmount: 5000 }, bulk: { maxAmount: 100 } } });
    expect(evaluateCart(bulkLine, rules)).toHaveLength(1);
    expect(evaluateCart(bulkLine, config({ quantityLimits: { all: { maxAmount: 5000 } } }))).toHaveLength(0);
  });

  it("ignores an amount bound on a limit the cart does not match", () => {
    // An amount bound only has meaning for limits it applies to. The editor
    // offers these fields on the "Every product" row, so a bound attached to a
    // tag or product that is not in the cart is legacy or hand-edited data --
    // it must not block an unrelated order, and the tightest *matching* bound
    // is the only one that counts.
    const cheap = line(1, 20);
    expect(evaluateCart(cheap, config({ quantityLimits: { bulk: { minAmount: 50 } } }))).toHaveLength(0);
    expect(evaluateCart(cheap, config({ quantityLimits: { premium: { maxAmount: 5 } } }))).toHaveLength(0);

    // An unrelated high minimum must not override a matching general one.
    const mixed = config({ quantityLimits: { all: { minAmount: 10 }, premium: { minAmount: 9000 } } });
    expect(evaluateCart(cheap, mixed)).toHaveLength(0);

    // The global row still gates the whole order.
    expect(evaluateCart(cheap, config({ quantityLimits: { all: { minAmount: 50 } } }))).toHaveLength(1);

    // And a matching tag still applies.
    const tagged = { email: null, addresses: [], lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity: 1, tags: ["Bulk"], unitPrice: 20 }] };
    expect(evaluateCart(tagged, config({ quantityLimits: { bulk: { minAmount: 50 } } }))).toHaveLength(1);
  });

  it("never blocks on a cart with no prices at all", () => {
    const cart = { email: null, addresses: [], lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity: 2, tags: [] }] };
    expect(evaluateCart(cart, config({ quantityLimits: { all: { minAmount: 50, maxAmount: 500 } } }))).toHaveLength(0);
  });

  it("reads legacy maximum-only limits and drops bounds that make no sense", () => {
    const raw = JSON.stringify({ a: 10, b: { max: 5 }, c: { min: 3, max: 2 }, d: { maxAmount: -1 }, e: {} });
    expect(parseConfig({ quantity_limits: raw }).quantityLimits).toEqual({ a: { max: 10 }, b: { max: 5 } });
  });

  const tagged = (quantity: number, tag: string) => ({
    email: null,
    addresses: [],
    lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity, tags: [tag] }],
  });

  it("keeps a tag limit when a looser limit also matches", () => {
    // A tag limit must tighten the "every product" limit, never be replaced by it.
    const rules = config({ quantityLimits: { all: { max: 10 }, bulk: { max: 3 } } });
    const violations = evaluateCart(tagged(5, "bulk"), rules);
    expect(violations).toHaveLength(1);
    expect(detailText(violations[0].detail)).toContain('tag "bulk"');
    expect(evaluateCart(tagged(5, "other"), rules)).toHaveLength(0);
  });

  it("applies the largest minimum when several limits match", () => {
    const rules = config({ quantityLimits: { all: { min: 2 }, bulk: { min: 4 } } });
    expect(evaluateCart(tagged(3, "bulk"), rules)).toHaveLength(1);
    expect(evaluateCart(tagged(4, "bulk"), rules)).toHaveLength(0);
  });

  it("blocks the maximum first when a product is under its minimum and over its maximum", () => {
    const rules = config({ quantityLimits: { all: { min: 3, max: 5 } } });
    const violations = evaluateCart(line(9), rules);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(/up to 5/);
  });

  it("keeps a custom message on both the minimum and the maximum", () => {
    const rules = config({ quantityLimits: { all: { min: 3, message: "Buy at least 3." } } });
    expect(evaluateCart(line(1), rules)[0].message).toBe("Buy at least 3.");
  });
});

describe("VIP bypass", () => {
  it("skips quantity, amount, address and region rules for a signed-in VIP", () => {
    const rules = config({
      regexRules: [poBox],
      quantityLimits: { all: { min: 10, max: 1, minAmount: 10_000, maxAmount: 1 } },
      geoBlocklist: { countries: [], zips: ["90210"], cities: [], states: [] },
      vipAllowlist: ["vip@store.com"],
    });
    const cart = {
      email: null,
      customerEmail: "vip@store.com",
      lines: [{ index: 0, productId: "gid://shopify/Product/1", quantity: 1, tags: [], unitPrice: 5 }],
      addresses: [{ groupIndex: 0, address: { address1: "P.O. Box 1", zip: "90210", countryCode: "US" } }],
    };
    expect(evaluateCart(cart, rules)).toHaveLength(0);
  });

  it("still applies the minimum and maximum to everyone else", () => {
    const rules = config({ quantityLimits: { all: { min: 5 } }, vipAllowlist: ["vip@store.com"] });
    const cart = {
      email: null,
      customerEmail: "other@store.com",
      lines: [{ index: 0, productId: "p1", quantity: 1, tags: [] }],
      addresses: [],
    };
    expect(evaluateCart(cart, rules)).toHaveLength(1);
  });
});

describe("amount limits through the Function", () => {
  const input = {
    cart: {
      lines: [
        {
          quantity: 2,
          cost: { amountPerQuantity: { amount: "250.00" } },
          merchandise: { __typename: "ProductVariant", product: { id: "gid://shopify/Product/1", hasTags: [] } },
        },
      ],
      deliveryGroups: [],
      cost: { totalAmount: { amount: "500.00", currencyCode: "USD" } },
    },
    shop: {
      settings: { value: JSON.stringify({ enable_quantity: true }) },
      quantity_limits: { value: JSON.stringify({ all: { maxAmount: 400 } }) },
    },
  };

  it("reads the cart total from the Function input", () => {
    const errors = run(input).operations[0].validationAdd.errors;
    expect(errors).toHaveLength(1);
    expect(errors[0].target).toBe("$.cart.cost.totalAmount");
    expect(errors[0].message).toMatch(/\$400\.00/);
  });

  it("ignores an unreadable total and still uses the line prices", () => {
    const broken = { ...input, cart: { ...input.cart, cost: { totalAmount: { amount: "" } } } };
    expect(run(broken).operations[0].validationAdd.errors).toHaveLength(1);
  });

  it("blocks nothing when no price is readable anywhere", () => {
    const priceless = { ...input, cart: { lines: [], deliveryGroups: [], cost: { totalAmount: { amount: "n/a" } } } };
    expect(run(priceless).operations[0].validationAdd.errors).toHaveLength(0);
  });

  it("falls back to line prices when the cart total is missing", () => {
    const noTotal = { ...input, cart: { lines: input.cart.lines, deliveryGroups: [] } };
    expect(run(noTotal).operations[0].validationAdd.errors).toHaveLength(1);
  });
});
