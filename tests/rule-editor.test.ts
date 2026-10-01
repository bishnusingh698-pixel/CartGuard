import { describe, expect, it } from "vitest";
import { ADDRESS_PRESETS, type RuleConfig } from "../extensions/cartguard-validator/src/rules";
import {
  KEYWORD_MESSAGE,
  configFromEditor,
  editorFromConfig,
  literalText,
  newAddressRule,
  newLimit,
  parseCountryEntry,
  parseVipAddress,
  parseVipEmail,
  parseZip,
  validateEditor,
} from "../app/lib/rule-editor";
import { validateRuleConfig } from "../app/lib/cartguard.server";
import { describeScopedEntry, describeStateEntry, findCountry } from "../app/lib/regions";

const ALL_ON = { enable_vip: true, enable_po_box: true, enable_quantity: true, enable_geo: true };

const empty = (): RuleConfig => ({
  settings: { ...ALL_ON },
  regexRules: [],
  quantityLimits: {},
  geoBlocklist: { countries: [], zips: [], cities: [], states: [] },
  vipAllowlist: [],
});

describe("rules editor round trip (everything JSON mode could set)", () => {
  const stored: RuleConfig = {
    settings: { ...ALL_ON },
    regexRules: [
      { preset: "po_box", pattern: ADDRESS_PRESETS.po_box.pattern, message: "No PO Boxes, sorry." },
      { preset: "keywords", keywords: ["mail drop"], pattern: "mail drop", message: KEYWORD_MESSAGE },
      { preset: "street", street: "Calle 5", pattern: "Calle 5", country: "CR", message: "We don't ship here." },
      { pattern: "\\bunit\\s+\\d+", city: "Miami" },
    ],
    quantityLimits: { bulk: { max: 10, message: "Max 10" }, all: { max: 50 }, "gid://shopify/Product/42": { max: 2 } },
    geoBlocklist: { countries: ["KZ"], zips: ["US:90210"], cities: ["San José"], states: ["US-CA"] },
    vipAllowlist: ["vip@store.com", "123 Executive Blvd"],
  };

  it("loads and saves every rule type without losing anything", () => {
    const editor = editorFromConfig(stored);
    expect(validateEditor(editor).total).toBe(0);
    expect(editor.addressRules.map((row) => row.match)).toEqual(["contains", "pattern"]);

    const saved = configFromEditor(editor);
    expect(saved.regexRules).toEqual(stored.regexRules);
    expect(saved.geoBlocklist).toEqual(stored.geoBlocklist);
    expect(saved.vipAllowlist).toEqual(stored.vipAllowlist);
    expect(saved.quantityLimits).toEqual({ bulk: { max: 10, message: "Max 10" }, all: { max: 50 }, "42": { max: 2 } });
    expect(validateRuleConfig(saved).errors).toEqual({});
  });

  it("keeps custom messages on built-in checks", () => {
    const saved = configFromEditor(editorFromConfig(stored));
    expect(saved.regexRules[0].message).toBe("No PO Boxes, sorry.");
  });

  it("turns literal patterns into plain text rows", () => {
    expect(literalText("warehouse 4b")).toBe("warehouse 4b");
    expect(literalText("a\\.b")).toBe("a.b");
    expect(literalText("\\bunit")).toBeNull();
  });
});

describe("rules editor validation", () => {
  it("flags bad patterns, bad limits and duplicates", () => {
    const editor = editorFromConfig(empty());
    editor.addressRules = [{ ...newAddressRule(), match: "pattern", text: "(a+)+$" }];
    editor.limits = [
      { ...newLimit(), value: "bulk", max: "0" },
      { ...newLimit(), value: "BULK", max: "5" },
    ];
    const errors = validateEditor(editor);
    expect(errors.bySection.address).toBe(1);
    expect(errors.bySection.quantity).toBe(2);
  });

  it("ignores untouched empty rows", () => {
    const editor = editorFromConfig(empty());
    editor.addressRules = [newAddressRule()];
    editor.limits = [newLimit()];
    expect(validateEditor(editor).total).toBe(0);
    expect(configFromEditor(editor).regexRules).toEqual([]);
  });

  it("flags entries saved by older versions that aren't valid", () => {
    const editor = editorFromConfig({ ...empty(), geoBlocklist: { countries: [], zips: [], cities: [], states: ["California"] } });
    expect(validateEditor(editor).bySection.geo).toBe(1);
  });
});

describe("field parsers and labels", () => {
  it("resolves countries by name, code or alias", () => {
    expect(parseCountryEntry("Costa Rica")).toEqual({ value: "CR" });
    expect(parseCountryEntry("kz")).toEqual({ value: "KZ" });
    expect(findCountry("UK")).toBe("GB");
    expect("error" in parseCountryEntry("Narnia")).toBe(true);
    expect("error" in parseCountryEntry("ZZ")).toBe(true);
  });

  it("validates postal codes, emails and addresses", () => {
    expect(parseZip("nw1 6xe")).toEqual({ value: "NW1 6XE" });
    expect("error" in parseZip("!!")).toBe(true);
    expect("error" in parseVipEmail("not-an-email")).toBe(true);
    expect("error" in parseVipAddress("12")).toBe(true);
  });

  it("describes scoped entries in plain language", () => {
    expect(describeStateEntry("US-CA")).toBe("California, United States");
    expect(describeStateEntry("WA")).toBe("WA (any country)");
    expect(describeScopedEntry("US:Austin")).toBe("Austin, United States");
  });
});

describe("minimum, maximum and order amount limits", () => {
  it("round trips every bound through the editor", () => {
    const stored: RuleConfig = {
      ...empty(),
      quantityLimits: {
        bulk: { min: 2, max: 10, message: "Between 2 and 10." },
        all: { minAmount: 50, maxAmount: 5000 },
      },
    };
    const editor = editorFromConfig(stored);
    expect(validateEditor(editor).total).toBe(0);
    expect(editor.limits.map((row) => [row.target, row.min, row.max, row.minAmount, row.maxAmount])).toEqual([
      ["tag", "2", "10", "", ""],
      ["all", "", "", "50", "5000"],
    ]);
    expect(configFromEditor(editor).quantityLimits).toEqual(stored.quantityLimits);
    expect(validateRuleConfig(configFromEditor(editor)).errors).toEqual({});
  });

  it("flags a minimum above the maximum and bounds that aren't whole numbers", () => {
    const editor = editorFromConfig(empty());
    editor.limits = [{ ...newLimit(), value: "bulk", min: "10", max: "2" }];
    editor.limits.push({ ...newLimit(), value: "other", max: "1.5" });
    expect(validateEditor(editor).bySection.quantity).toBe(2);
  });

  it("asks for at least one bound before a limit can be saved", () => {
    const editor = editorFromConfig(empty());
    editor.limits = [{ ...newLimit(), value: "bulk" }];
    expect(validateEditor(editor).bySection.quantity).toBe(1);
  });

  it("keeps order amounts on the Every product limit", () => {
    const editor = editorFromConfig(empty());
    editor.limits = [{ ...newLimit(), value: "bulk", max: "5", minAmount: "50" }];
    expect(validateEditor(editor).fields[editor.limits[0].id].minAmount).toBeTruthy();
  });

  it("flags an order total range that runs backwards", () => {
    const editor = editorFromConfig(empty());
    editor.limits = [{ ...newLimit(), target: "all", minAmount: "500", maxAmount: "50" }];
    expect(validateEditor(editor).bySection.quantity).toBe(1);
  });

  it("rejects impossible or unbounded limits on the server", () => {
    const bad = [
      { quantityLimits: { bulk: { min: 5, max: 2 } } },
      { quantityLimits: { all: { minAmount: 500, maxAmount: 50 } } },
      { quantityLimits: { bulk: { maxAmount: 100 } } },
      { quantityLimits: { bulk: { min: 0 } } },
      { quantityLimits: { all: { maxAmount: 2_000_000 } } },
      { quantityLimits: { bulk: { message: "no bounds" } } },
    ];
    for (const input of bad) {
      expect(validateRuleConfig(input).errors.quantity, JSON.stringify(input)).toBeTruthy();
    }
  });

  it("saves the bounds that are valid", () => {
    const { config, errors } = validateRuleConfig({
      quantityLimits: { all: { minAmount: 49.999, maxAmount: 1000 }, bulk: { min: 1, max: 4, message: "1 to 4 only." } },
    });
    expect(errors).toEqual({});
    expect(config?.quantityLimits).toEqual({
      all: { minAmount: 50, maxAmount: 1000 },
      bulk: { min: 1, max: 4, message: "1 to 4 only." },
    });
  });
});
