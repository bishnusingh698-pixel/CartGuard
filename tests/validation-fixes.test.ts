import { describe, expect, it } from "vitest";
import { isValidStateEntry } from "../app/lib/regions";
import { parseKeyword, parseRegionCode, parseZip } from "../app/lib/rule-editor";
import { summarizeSections } from "../app/lib/rule-summary";
import { validateRuleConfig } from "../app/lib/cartguard.server";

describe("region codes", () => {
  it("accepts Shopify codes longer than 3 characters and with a space", () => {
    expect(isValidStateEntry("MX-TAMPS")).toBe(true);
    expect(isValidStateEntry("MX-Q ROO")).toBe(true);
    expect(isValidStateEntry("JP-13")).toBe(true);
    expect(parseRegionCode("q  roo")).toEqual({ value: "Q ROO" });
    expect(validateRuleConfig({ geoBlocklist: { states: ["MX-TAMPS"] } }).errors.geo).toBeUndefined();
  });

  it("checks US, Canada and Australia codes against the built-in lists", () => {
    expect(isValidStateEntry("US-CA")).toBe(true);
    expect(isValidStateEntry("AU-NSW")).toBe(true);
    expect(isValidStateEntry("US-TEXAS")).toBe(false);
    expect(isValidStateEntry("California")).toBe(false);
  });
});

describe("relaxed limits that older versions accepted", () => {
  it("accepts 2-character blocked words and long postal codes", () => {
    expect(parseKeyword("4B")).toEqual({ value: "4B" });
    expect(parseZip("12345-67890")).toEqual({ value: "12345-67890" });
  });
});

describe("section summaries", () => {
  it("ignores a limit that is still being typed", () => {
    const summary = summarizeSections({
      settings: { enable_vip: false, enable_po_box: false, enable_quantity: true, enable_geo: false },
      regexRules: [],
      quantityLimits: { bulk: { max: Number.NaN } },
      geoBlocklist: { countries: [], zips: [], cities: [], states: [] },
      vipAllowlist: [],
    });
    expect(summary.quantity.details.join(" ")).not.toContain("NaN");
    expect(summary.quantity.empty).toBe(true);
  });
});
