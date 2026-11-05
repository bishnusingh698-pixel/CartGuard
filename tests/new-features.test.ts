import { describe, expect, it } from "vitest";
import {
  ADDRESS_PRESETS,
  DEFAULT_EMAIL_MESSAGE,
  emailDomain,
  evaluateCart,
  parseConfig,
  type CartInput,
  type RuleConfig,
} from "../extensions/cartfence-validator/src/rules";
import { run } from "../extensions/cartfence-validator/src/run";
import { configFromEditor, editorFromConfig, newLimit, parseEmailDomain, validateEditor } from "../app/lib/rule-editor";
import { serializeConfig, simulateOrders, validateRuleConfig } from "../app/lib/cartfence.server";
import { summarizeSections } from "../app/lib/rule-summary";
import { RULE_TEMPLATES, applyTemplate, templateApplied } from "../app/lib/rule-templates";
import { EMPTY_TESTER_INPUT, hasTesterInput, testCheckout } from "../app/components/checkout-tester";

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

const cart = (overrides: Partial<CartInput> = {}): CartInput => ({ lines: [], addresses: [], ...overrides });
const at = (address1: string, address2 = "", countryCode = "US"): CartInput =>
  cart({ addresses: [{ groupIndex: 0, address: { address1, address2, city: "Austin", countryCode } }] });
const houseNumber = (country?: string) => ({
  preset: "house_number",
  pattern: ADDRESS_PRESETS.house_number.pattern,
  message: ADDRESS_PRESETS.house_number.message,
  ...(country ? { country } : {}),
});

describe("email rules", () => {
  it("blocks listed domains and their subdomains, not lookalikes", () => {
    const c = config({ emailBlocklist: { domains: ["fraud.test"], blockDisposable: false } });
    expect(evaluateCart(cart({ email: "a@fraud.test" }), c)).toHaveLength(1);
    expect(evaluateCart(cart({ email: "a@mail.FRAUD.test" }), c)).toHaveLength(1);
    expect(evaluateCart(cart({ email: "a@notfraud.test" }), c)).toHaveLength(0);
    expect(evaluateCart(cart({ email: "a@fraud.test.example" }), c)).toHaveLength(0);
  });

  it("blocks throwaway services only when switched on", () => {
    const on = config({ emailBlocklist: { domains: [], blockDisposable: true } });
    const [violation] = evaluateCart(cart({ email: "x@mailinator.com" }), on);
    expect(violation).toMatchObject({ rule: "email", message: DEFAULT_EMAIL_MESSAGE, target: "$.cart.buyerIdentity.email" });
    expect(violation.detail).toContain("throwaway");
    expect(evaluateCart(cart({ email: "x@gmail.com" }), on)).toHaveLength(0);
    expect(evaluateCart(cart({ email: "x@mailinator.com" }), config())).toHaveLength(0);
  });

  it("checks the account email too, and does nothing when the section is off", () => {
    const c = config({ emailBlocklist: { domains: ["fraud.test"], blockDisposable: false, message: "No." } });
    expect(evaluateCart(cart({ customerEmail: "a@fraud.test" }), c)[0].message).toBe("No.");
    expect(evaluateCart(cart({ email: "a@fraud.test" }), { ...c, settings: { ...ALL_ON, enable_email: false } })).toHaveLength(0);
  });

  it("lets signed-in trusted customers through", () => {
    const c = config({ vipAllowlist: ["vip@fraud.test"], emailBlocklist: { domains: ["fraud.test"], blockDisposable: false } });
    expect(evaluateCart(cart({ email: "vip@fraud.test", customerEmail: "vip@fraud.test" }), c)).toHaveLength(0);
    expect(evaluateCart(cart({ email: "vip@fraud.test" }), c)).toHaveLength(1);
  });

  it("works without email rules in older configs and with no email at all", () => {
    const legacy = config();
    delete legacy.emailBlocklist;
    expect(evaluateCart(cart({ email: "a@mailinator.com" }), legacy)).toHaveLength(0);
    expect(evaluateCart(cart(), config({ emailBlocklist: { domains: ["x.test"], blockDisposable: true } }))).toHaveLength(0);
  });

  it("parses the metafield tolerantly and reaches checkout through the Function", () => {
    expect(parseConfig({ email_blocklist: '{"domains":["@Fraud.Test.", "not a domain", 5],"blockDisposable":true}' }).emailBlocklist).toEqual({
      domains: ["fraud.test"],
      blockDisposable: true,
    });
    expect(parseConfig({ email_blocklist: "garbage" }).emailBlocklist).toEqual({ domains: [], blockDisposable: false });
    const result = run({
      cart: { buyerIdentity: { email: "a@yopmail.com" } },
      shop: {
        settings: { value: JSON.stringify({ enable_email: true }) },
        email_blocklist: { value: JSON.stringify({ domains: [], blockDisposable: true }) },
      },
    });
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  it("extracts domains safely", () => {
    expect(emailDomain("Someone@Example.COM")).toBe("example.com");
    expect(emailDomain("no-at-sign")).toBe("");
    expect(emailDomain("@example.com")).toBe("");
  });
});

describe("street number rule", () => {
  const c = config({ regexRules: [houseNumber()] });

  it("blocks a street with no number on either line", () => {
    expect(evaluateCart(at("Main Street"), c)).toHaveLength(1);
    expect(evaluateCart(at("Main Street", "Apt 4"), c)).toHaveLength(0);
    expect(evaluateCart(at("12 Main Street"), c)).toHaveLength(0);
    expect(evaluateCart(at("Hauptstraße １２"), c)).toHaveLength(0); // full-width digits
    expect(evaluateCart(at("شارع ١٢"), c)).toHaveLength(0); // Arabic-Indic digits
  });

  it("never looks at the city, and skips addresses without a street line", () => {
    expect(evaluateCart(cart({ addresses: [{ groupIndex: 0, address: { address1: "5 Oak Rd", city: "Springfield" } }] }), c)).toHaveLength(0);
    expect(evaluateCart(cart({ addresses: [{ groupIndex: 0, address: { city: "Springfield", countryCode: "US" } }] }), c)).toHaveLength(0);
  });

  it("can be limited to one country", () => {
    const usOnly = config({ regexRules: [houseNumber("US")] });
    expect(evaluateCart(at("Rose Cottage", "", "GB"), usOnly)).toHaveLength(0);
    expect(evaluateCart(at("Rose Cottage", "", "US"), usOnly)).toHaveLength(1);
  });

  it("is exempt for a trusted street address", () => {
    const vip = config({ regexRules: [houseNumber()], vipAllowlist: ["Rose Cottage"] });
    expect(evaluateCart(at("Rose Cottage"), vip)).toHaveLength(0);
  });
});

describe("pack sizes", () => {
  const line = (quantity: number, tags: string[] = []) => ({ index: 0, productId: "gid://shopify/Product/1", quantity, tags });

  it("requires quantities in multiples, using the largest pack size that applies", () => {
    const c = config({ quantityLimits: { all: { multiple: 2 }, six: { multiple: 6 } } });
    expect(evaluateCart(cart({ lines: [line(4)] }), c)).toHaveLength(0);
    expect(evaluateCart(cart({ lines: [line(3)] }), c)[0].message).toContain("packs of 2");
    expect(evaluateCart(cart({ lines: [line(4, ["six"])] }), c)[0].message).toContain("packs of 6");
    expect(evaluateCart(cart({ lines: [line(12, ["six"])] }), c)).toHaveLength(0);
  });

  it("reports the maximum before the pack size", () => {
    const c = config({ quantityLimits: { all: { max: 10, multiple: 4 } } });
    expect(evaluateCart(cart({ lines: [line(13)] }), c)[0].detail).toContain("exceed");
  });

  it("parses, validates and round trips through the editor", () => {
    expect(parseConfig({ quantity_limits: '{"all":{"multiple":3},"bad":{"multiple":1}}' }).quantityLimits).toEqual({ all: { multiple: 3 } });
    expect(validateRuleConfig({ quantityLimits: { all: { multiple: 1 } } }).errors.quantity).toContain("pack size");
    expect(validateRuleConfig({ quantityLimits: { all: { multiple: 6 } } }).config?.quantityLimits).toEqual({ all: { multiple: 6 } });

    const editor = editorFromConfig(config({ quantityLimits: { bulk: { multiple: 6 } } }));
    expect(editor.limits[0].multiple).toBe("6");
    expect(configFromEditor(editor).quantityLimits).toEqual({ bulk: { multiple: 6 } });
    editor.limits = [{ ...newLimit(), value: "bulk", multiple: "1" }];
    expect(validateEditor(editor).fields[editor.limits[0].id].multiple).toBeDefined();
  });
});

describe("editor and server for the new rules", () => {
  it("round trips email rules and the street number check", () => {
    const stored = config({
      regexRules: [houseNumber("US")],
      emailBlocklist: { domains: ["fraud.test"], blockDisposable: true, message: "Use another email." },
    });
    const editor = editorFromConfig(stored);
    expect(editor.checks.house_number).toBe(true);
    expect(editor.houseNumberCountry).toBe("US");
    expect(validateEditor(editor).total).toBe(0);
    const saved = configFromEditor(editor);
    expect(saved.regexRules).toEqual(stored.regexRules);
    expect(saved.emailBlocklist).toEqual(stored.emailBlocklist);
    expect(validateRuleConfig(saved)).toEqual({ config: saved, errors: {} });
    expect(JSON.parse(serializeConfig(saved).email_blocklist)).toEqual(stored.emailBlocklist);
  });

  it("only ever keeps the domain of an email typed into the list", () => {
    expect(parseEmailDomain("someone@Fraud.test")).toEqual({ value: "fraud.test" });
    expect("error" in parseEmailDomain("not a domain")).toBe(true);
    expect(validateRuleConfig({ emailBlocklist: { domains: ["nope"] } }).errors.email).toBeDefined();
  });

  it("summarizes the email section and counts it in the order check", () => {
    const c = config({ emailBlocklist: { domains: ["a.test", "b.test"], blockDisposable: true } });
    expect(summarizeSections(c).email).toEqual({
      enabled: true,
      empty: false,
      details: [{ key: "summary.email.disposable" }, { key: "summary.email.domains", count: 2 }],
    });
    const result = simulateOrders([{ id: "gid://shopify/Order/1", name: "#1", email: "a@a.test" }], c);
    expect(result.bySection.email).toBe(1);
    expect(result.matches[0].sections).toEqual(["email"]);
  });
});

describe("templates", () => {
  it("fills the form without saving, and each one reports itself as added", () => {
    const base = editorFromConfig(config({ settings: { enable_vip: false, enable_po_box: false, enable_quantity: false, enable_geo: false, enable_email: false } }));
    for (const template of RULE_TEMPLATES) {
      expect(templateApplied(base, template)).toBe(false);
      const next = applyTemplate(base, template);
      expect(templateApplied(next, template)).toBe(true);
      expect(validateEditor(next).total).toBe(0);
    }
  });

  it("shares one Every product row and never overwrites typed values", () => {
    let state = editorFromConfig(config());
    state = applyTemplate(applyTemplate(state, "resellers"), "minimumOrder");
    expect(state.limits).toHaveLength(1);
    expect(configFromEditor(state).quantityLimits).toEqual({ all: { max: 5, minAmount: 25 } });

    const typed = editorFromConfig(config({ quantityLimits: { all: { max: 2 } } }));
    expect(configFromEditor(applyTemplate(typed, "resellers")).quantityLimits).toEqual({ all: { max: 2 } });
  });
});

describe("try a checkout", () => {
  it("runs the draft rules on what the merchant types", () => {
    const c = config({ geoBlocklist: { countries: ["KZ"], zips: [], cities: [], states: [] }, emailBlocklist: { domains: [], blockDisposable: true } });
    expect(hasTesterInput(EMPTY_TESTER_INPUT)).toBe(false);
    expect(testCheckout({ ...EMPTY_TESTER_INPUT, countryCode: "KZ" }, c)).toHaveLength(1);
    expect(testCheckout({ ...EMPTY_TESTER_INPUT, countryCode: "US" }, c)).toHaveLength(0);
    expect(testCheckout({ ...EMPTY_TESTER_INPUT, email: "a@mailinator.com" }, c)[0].rule).toBe("email");
  });

  it("only treats the customer as trusted when signed in", () => {
    const c = config({ vipAllowlist: ["vip@shop.test"], emailBlocklist: { domains: ["shop.test"], blockDisposable: false } });
    const input = { ...EMPTY_TESTER_INPUT, email: "vip@shop.test" };
    expect(testCheckout(input, c)).toHaveLength(1);
    expect(testCheckout({ ...input, signedIn: true }, c)).toHaveLength(0);
  });
});
