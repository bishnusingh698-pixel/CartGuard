import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCT_COUNTRY_MESSAGE,
  collectLimitTags,
  collectVipTags,
  evaluateCart,
  parseConfig,
  type CartInput,
  type RuleConfig,
} from "../extensions/cartfence-validator/src/rules";
import { run } from "../extensions/cartfence-validator/src/run";
import {
  configFromEditor,
  editorFromConfig,
  newLimit,
  newProductRule,
  parseCustomerTag,
  validateEditor,
} from "../app/lib/rule-editor";
import { serializeConfig, simulateOrders, validateRuleConfig } from "../app/lib/cartfence.server";
import { summarizeSections } from "../app/lib/rule-summary";

const ALL_ON = { enable_vip: true, enable_po_box: true, enable_quantity: true, enable_geo: true, enable_email: true };

const config = (overrides: Partial<RuleConfig> = {}): RuleConfig => ({
  settings: { ...ALL_ON },
  regexRules: [],
  quantityLimits: {},
  geoBlocklist: { countries: [], zips: [], cities: [], states: [] },
  vipAllowlist: [],
  emailBlocklist: { domains: [], blockDisposable: false },
  ...overrides,
});

const line = (index: number, quantity: number, tags: string[] = [], productId = `gid://shopify/Product/${index + 1}`) => ({
  index,
  productId,
  quantity,
  tags,
});
const shipTo = (countryCode: string) => [{ groupIndex: 0, address: { address1: "1 Main St", city: "Town", countryCode } }];
const cart = (overrides: Partial<CartInput> = {}): CartInput => ({ lines: [], addresses: [], ...overrides });

const batteries = { products: [{ tag: "battery", countries: ["AU", "NZ"] }] };
const geo = (extra: object = {}) => ({ countries: [], zips: [], cities: [], states: [], ...extra });

describe("products that can't ship to some countries", () => {
  it("blocks the tagged line when it ships to a listed country, and only that line", () => {
    const c = config({ geoBlocklist: geo(batteries) });
    const violations = evaluateCart(cart({ lines: [line(0, 1), line(1, 2, ["Battery"])], addresses: shipTo("AU") }), c);
    expect(violations).toEqual([
      expect.objectContaining({ rule: "product", message: DEFAULT_PRODUCT_COUNTRY_MESSAGE, target: "$.cart.lines[1].quantity" }),
    ]);
    expect(violations[0].detail).toContain('"battery"');
  });

  it("lets the same cart through to other countries, before an address exists, or with geo off", () => {
    const c = config({ geoBlocklist: geo(batteries) });
    const lines = [line(0, 1, ["battery"])];
    expect(evaluateCart(cart({ lines, addresses: shipTo("US") }), c)).toHaveLength(0);
    expect(evaluateCart(cart({ lines }), c)).toHaveLength(0);
    expect(evaluateCart(cart({ lines, addresses: shipTo("AU") }), config({ ...c, settings: { ...ALL_ON, enable_geo: false } }))).toHaveLength(0);
  });

  it("still applies to trusted customers, like blocked countries", () => {
    const c = config({ geoBlocklist: geo(batteries), vipAllowlist: ["vip@example.com", "tag:wholesale"] });
    const input = cart({ lines: [line(0, 1, ["battery"])], addresses: shipTo("NZ"), customerEmail: "vip@example.com", customerTags: ["wholesale"] });
    expect(evaluateCart(input, c).map((v) => v.rule)).toEqual(["product"]);
  });

  it("uses the merchant's message", () => {
    const c = config({ geoBlocklist: geo({ products: [{ tag: "wine", countries: ["SA"], message: "We can't send wine there." }] }) });
    expect(evaluateCart(cart({ lines: [line(0, 1, ["wine"])], addresses: shipTo("SA") }), c)[0].message).toBe("We can't send wine there.");
  });

  it("drops stored rules with no tag or no countries", () => {
    const parsed = parseConfig({
      geo_blocklist: JSON.stringify({ products: [{ tag: "", countries: ["AU"] }, { tag: "x", countries: [] }, { tag: "ok", countries: ["australia"] }, 5] }),
    });
    expect(parsed.geoBlocklist.products).toEqual([{ tag: "ok", countries: ["AU"] }]);
    expect(parseConfig({ geo_blocklist: JSON.stringify({ countries: ["RU"] }) }).geoBlocklist.products).toBeUndefined();
  });

  it("asks checkout about the tags, product rules first, without duplicates", () => {
    const tags = collectLimitTags({ bulk: { max: 5 }, BATTERY: { max: 2 }, all: { max: 9 } }, geo(batteries));
    expect(tags).toEqual(["battery", "bulk"]);
  });

  it("is enforced end to end by the Function", () => {
    const shop = {
      settings: { value: JSON.stringify(ALL_ON) },
      geo_blocklist: { value: JSON.stringify(geo(batteries)) },
    };
    const result = run({
      shop,
      cart: {
        lines: [
          { quantity: 1, merchandise: { __typename: "ProductVariant", product: { id: "gid://shopify/Product/1", hasTags: [{ tag: "battery", hasTag: true }] } } },
        ],
        deliveryGroups: [{ deliveryAddress: { countryCode: "AU" } }],
      },
    });
    expect(result.operations[0].validationAdd.errors).toEqual([{ message: DEFAULT_PRODUCT_COUNTRY_MESSAGE, target: "$.cart.lines[0].quantity" }]);
  });

  it("shows up in the Impact Checker under countries and regions", () => {
    const c = config({ geoBlocklist: geo(batteries) });
    const result = simulateOrders(
      [
        {
          id: "gid://shopify/Order/1",
          name: "#1001",
          shippingAddress: { countryCode: "AU", city: "Sydney" },
          lineItems: { nodes: [{ quantity: 1, product: { id: "gid://shopify/Product/9", tags: ["Battery", "other"] } }] },
        },
      ],
      c,
    );
    expect(result.blocked).toBe(1);
    expect(result.bySection.geo).toBe(1);
  });
});

describe("items per order", () => {
  const capped = config({ quantityLimits: { all: { maxItems: 5 } } });

  it("counts every product together", () => {
    const [violation] = evaluateCart(cart({ lines: [line(0, 3), line(1, 3)] }), capped);
    expect(violation).toMatchObject({ rule: "quantity", target: "$.cart" });
    expect(violation.message).toContain("up to 5 items");
    expect(evaluateCart(cart({ lines: [line(0, 2), line(1, 3)] }), capped)).toHaveLength(0);
  });

  it("enforces a minimum, but never on an empty cart", () => {
    const c = config({ quantityLimits: { all: { minItems: 3 } } });
    expect(evaluateCart(cart({ lines: [line(0, 2)] }), c)[0].message).toContain("at least 3 items");
    expect(evaluateCart(cart({ lines: [line(0, 3)] }), c)).toHaveLength(0);
    expect(evaluateCart(cart(), c)).toHaveLength(0);
  });

  it("ignores item counts on tag rows and lets trusted customers through", () => {
    expect(evaluateCart(cart({ lines: [line(0, 9, ["bulk"])] }), config({ quantityLimits: { bulk: { maxItems: 2 } } }))).toHaveLength(0);
    const vip = config({ quantityLimits: { all: { maxItems: 1 } }, vipAllowlist: ["tag:wholesale"] });
    expect(evaluateCart(cart({ lines: [line(0, 9)], customerTags: ["Wholesale"] }), vip)).toHaveLength(0);
  });

  it("parses stored limits that only set item counts and rejects inverted ones", () => {
    expect(parseConfig({ quantity_limits: JSON.stringify({ all: { maxItems: 10 } }) }).quantityLimits).toEqual({ all: { maxItems: 10 } });
    expect(parseConfig({ quantity_limits: JSON.stringify({ all: { minItems: 10, maxItems: 2 } }) }).quantityLimits).toEqual({});
  });
});

describe("trusted customer tags", () => {
  const c = config({ quantityLimits: { all: { max: 1 } }, vipAllowlist: ["tag:wholesale", "tag: VIP "] });
  const big = (overrides: Partial<CartInput> = {}) => cart({ lines: [line(0, 4)], ...overrides });

  it("lets signed-in customers with a trusted tag skip the rules", () => {
    expect(evaluateCart(big({ customerTags: ["wholesale"] }), c)).toHaveLength(0);
    expect(evaluateCart(big({ customerTags: ["vip"] }), c)).toHaveLength(0);
    expect(evaluateCart(big({ customerTags: ["retail"] }), c)).toHaveLength(1);
    expect(evaluateCart(big(), c)).toHaveLength(1);
  });

  it("does nothing when the trusted customers section is off", () => {
    expect(evaluateCart(big({ customerTags: ["wholesale"] }), config({ ...c, settings: { ...ALL_ON, enable_vip: false } }))).toHaveLength(1);
  });

  it("never treats a tag entry as a street address", () => {
    const addressRule = { pattern: "tag", message: "x" };
    const withRule = config({ regexRules: [addressRule], vipAllowlist: ["tag:wholesale"] });
    const input = cart({ addresses: [{ groupIndex: 0, address: { address1: "tag:wholesale", countryCode: "US" } }] });
    expect(evaluateCart(input, withRule)).toHaveLength(1);
  });

  it("reads the tags the Function asked about", () => {
    const result = run({
      shop: {
        settings: { value: JSON.stringify(ALL_ON) },
        quantity_limits: { value: JSON.stringify({ all: { max: 1 } }) },
        vip_allowlist: { value: JSON.stringify(["tag:wholesale"]) },
      },
      cart: {
        buyerIdentity: { customer: { email: "b@example.com", hasTags: [{ tag: "wholesale", hasTag: true }] } },
        lines: [{ quantity: 3, merchandise: { __typename: "ProductVariant", product: { id: "gid://shopify/Product/1", hasTags: [] } } }],
      },
    });
    expect(result.operations[0].validationAdd.errors).toEqual([]);
  });

  it("collects tags for the Function without the prefix or duplicates", () => {
    expect(collectVipTags(["a@b.com", "tag:wholesale", "TAG:Wholesale", "tag: vip", "123 Main Street"])).toEqual(["wholesale", "vip"]);
  });

  it("parses customer tags typed in the editor", () => {
    expect(parseCustomerTag(" tag: wholesale ")).toEqual({ value: "wholesale" });
    expect("error" in parseCustomerTag("a, b")).toBe(true);
    expect("error" in parseCustomerTag("  ")).toBe(true);
  });
});

describe("editor and save validation", () => {
  it("round-trips all three features through the editor", () => {
    const stored = config({
      quantityLimits: { all: { minItems: 2, maxItems: 20 } },
      geoBlocklist: geo({ products: [{ tag: "battery", countries: ["AU"], message: "No batteries to Australia." }] }),
      vipAllowlist: ["vip@example.com", "123 Main Street", "tag:wholesale"],
    });
    const editor = editorFromConfig(stored);
    expect(editor.vipTags).toEqual(["wholesale"]);
    expect(editor.vipAddresses).toEqual(["123 Main Street"]);
    expect(editor.productRules[0]).toMatchObject({ tag: "battery", countries: ["AU"] });
    expect(editor.limits[0]).toMatchObject({ minItems: "2", maxItems: "20" });
    expect(configFromEditor(editor)).toEqual(stored);
    expect(validateEditor(editor).total).toBe(0);
    expect(validateRuleConfig(JSON.parse(JSON.stringify(stored)))).toEqual({ config: stored, errors: {} });
  });

  it("flags half-filled product rules and item counts on tag rows", () => {
    const editor = editorFromConfig(config());
    editor.productRules = [{ ...newProductRule(), tag: "battery" }, { ...newProductRule(), countries: ["AU"] }];
    editor.limits = [{ ...newLimit(), value: "bulk", maxItems: "3" }, { ...newLimit(), target: "all", minItems: "9", maxItems: "3" }];
    const errors = validateEditor(editor);
    expect(errors.fields[editor.productRules[0].id].countries).toBeDefined();
    expect(errors.fields[editor.productRules[1].id].tag).toBeDefined();
    expect(errors.fields[editor.limits[0].id].maxItems).toContain("Every product");
    expect(errors.fields[editor.limits[1].id].minItems).toBeDefined();
    expect(errors.bySection.geo).toBe(2);
  });

  it("rejects bad product rules and tag-row item counts on save", () => {
    const geoErrors = validateRuleConfig({ geoBlocklist: { products: [{ tag: "battery", countries: ["Atlantis"] }] } }).errors;
    expect(geoErrors.geo).toContain("choose countries");
    const dup = validateRuleConfig({ geoBlocklist: { products: [{ tag: "a", countries: ["AU"] }, { tag: "A", countries: ["NZ"] }] } }).errors;
    expect(dup.geo).toContain("more than one");
    const qty = validateRuleConfig({ quantityLimits: { bulk: { maxItems: 3 } } }).errors;
    expect(qty.quantity).toContain("Every product");
  });

  it("serializes product rules inside the geo blocklist", () => {
    const stored = config({ geoBlocklist: geo(batteries) });
    expect(JSON.parse(serializeConfig(stored).geo_blocklist).products).toEqual(batteries.products);
  });

  it("summarizes the new rules", () => {
    const summary = summarizeSections(
      config({ geoBlocklist: geo(batteries), vipAllowlist: ["tag:wholesale", "a@b.com"] }),
    );
    expect(summary.geo.details).toContainEqual({ key: "summary.geo.products", count: 1 });
    expect(summary.vip.details).toContainEqual({ key: "summary.vip.tags", count: 1 });
    expect(summary.vip.details).toContainEqual({ key: "summary.vip.emails", count: 1 });
    expect(summary.vip.details.find((d) => d.key === "summary.vip.addresses")).toBeUndefined();
  });
});

describe("Order check when Shopify withholds one protected field", () => {
  it("drops only the refused field and keeps testing address rules", async () => {
    const queries: string[] = [];
    const admin = {
      graphql: async (query: string) => {
        queries.push(query);
        if (/\bemail\b/.test(query)) {
          return new Response(JSON.stringify({ errors: [{ message: "This app is not approved to use the email field." }] }));
        }
        return new Response(
          JSON.stringify({
            data: {
              orders: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "gid://shopify/Order/1", name: "#1", shippingAddress: { countryCode: "RU" }, lineItems: { nodes: [] } }],
              },
            },
          }),
        );
      },
    };
    const { simulateImpact } = await import("../app/lib/cartfence.server");
    const result = await simulateImpact(admin, config({ geoBlocklist: geo({ countries: ["RU"] }) }));
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("shippingAddress");
    expect(result.blocked).toBe(1);
    expect(result.hiddenFields).toEqual(["email"]);
  });

  it("names the rules that weren't tested", async () => {
    const { hiddenDataMessageKey } = await import("../app/lib/rule-summary");
    expect(hiddenDataMessageKey(["email"])).toBe("impact.emailHidden");
    expect(hiddenDataMessageKey(["address"])).toBe("impact.addressHidden");
    expect(hiddenDataMessageKey(["email", "address"])).toBe("impact.customerDataHidden");
  });
});
