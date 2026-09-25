import { describe, expect, it } from "vitest";
import { run } from "../extensions/cartguard-validator/src/run";
import {
  ADDRESS_PRESETS,
  collectLimitTags,
  evaluateCart,
  type CartAddress,
  type CartInput,
  type RegexRule,
  type RuleConfig,
} from "../extensions/cartguard-validator/src/rules";
import { parseDraftConfig, simulateOrders, validateDraftConfig } from "../app/lib/cartguard.server";

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
const freight: RegexRule = { preset: "freight", pattern: ADDRESS_PRESETS.freight.pattern, message: ADDRESS_PRESETS.freight.message };

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
    const rules = config({ regexRules: [poBox, freight] });
    expect(evaluateCart(cartAt({ address1: "12 Tempo Box Road", countryCode: "US" }), rules)).toHaveLength(0);
    expect(evaluateCart(cartAt({ address1: "1 Market St", address2: "Suite 400", countryCode: "US" }), rules)).toHaveLength(0);
  });

  it("blocks freight forwarders", () => {
    const violations = evaluateCart(cartAt({ address1: "Suite 400 Freight Forwarder Hub", countryCode: "US" }), config({ regexRules: [freight] }));
    expect(violations).toHaveLength(1);
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
  const validDraft = {
    regex_rules: JSON.stringify([poBox]),
    quantity_limits: JSON.stringify({ bulk: 10 }),
    geo_blocklist: JSON.stringify({ countries: ["Costa Rica"] }),
    vip_allowlist: JSON.stringify(["a@b.com"]),
  };

  it("accepts a valid draft and normalizes countries", () => {
    expect(validateDraftConfig(validDraft)).toEqual({});
    expect(parseDraftConfig(validDraft, ALL_ON).geoBlocklist.countries).toEqual(["CR"]);
  });

  it("rejects invalid regex and unknown countries", () => {
    const errors = validateDraftConfig({
      ...validDraft,
      regex_rules: JSON.stringify([{ pattern: "(" }]),
      geo_blocklist: JSON.stringify({ countries: ["Atlantis"] }),
    });
    expect(errors.regex_rules).toBeTruthy();
    expect(errors.geo_blocklist).toBeTruthy();
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
    expect(result.samples[0]).toContain("#1001");
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
    const errors = validateDraftConfig({ regex_rules: JSON.stringify([{ pattern: "(a+)+$" }]), quantity_limits: "", geo_blocklist: "", vip_allowlist: "" });
    expect(errors.regex_rules).toBeTruthy();
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
