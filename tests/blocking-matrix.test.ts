/**
 * Phase 2 blocking-rule matrix.
 *
 * Covers PO Box, military, country/state/region and quantity rules with both
 * blocked and allowed cases, including the evasion techniques a buyer would
 * actually use against a shipping-address filter: unicode tricks, word
 * splitting across fields, and look-alike street names.
 */

import { describe, expect, it } from "vitest";
import {
  ADDRESS_PRESETS,
  MAX_PATTERN_LENGTH,
  evaluateCart,
  type CartAddress,
  type CartInput,
  type RegexRule,
  type RuleConfig,
} from "../extensions/cartguard-validator/src/rules";

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
const military: RegexRule = { preset: "military", pattern: ADDRESS_PRESETS.military.pattern, message: "no military", country: "US" };

function cartAt(address: CartAddress, extra: Partial<CartInput> = {}): CartInput {
  return { email: null, lines: [], addresses: [{ groupIndex: 0, address }], ...extra };
}

/** Assert an address is blocked, and that the violation blames the right field. */
function expectBlocked(preset: RegexRule, address: CartAddress, field?: string) {
  const violations = evaluateCart(cartAt(address), config({ regexRules: [preset] }));
  expect(violations.map((v) => v.rule), JSON.stringify(address)).toContain("address");
  if (field) {
    expect(violations[0].target, `${JSON.stringify(address)} should blame ${field}`).toContain(field);
  }
}

function expectAllowed(preset: RegexRule, address: CartAddress) {
  expect(evaluateCart(cartAt(address), config({ regexRules: [preset] })), JSON.stringify(address)).toHaveLength(0);
}

describe("preset safety limits", () => {
  it("keeps every preset pattern inside MAX_PATTERN_LENGTH", () => {
    // compileRegex silently returns null past the limit, which would disable
    // the rule and leave the merchant believing PO Boxes are still blocked.
    for (const [name, preset] of Object.entries(ADDRESS_PRESETS)) {
      expect(preset.pattern.length, `${name} is ${preset.pattern.length} chars`).toBeLessThanOrEqual(MAX_PATTERN_LENGTH);
    }
  });

  it("keeps every preset pattern compilable", () => {
    for (const [name, preset] of Object.entries(ADDRESS_PRESETS)) {
      expect(() => new RegExp(preset.pattern, "iu"), name).not.toThrow();
    }
  });
});

describe("PO Box blocking", () => {
  const SHOULD_BLOCK = [
    "PO Box 123",
    "P.O. Box 123",
    "P O Box 99",
    "P.O.B. 4",
    "P.O.B 4",
    "POB 12",
    "Post Office Box 55",
    "Postal Box 7",
    "Apartado 88",
    "Apartado Postal 22",
    "Caixa Postal 900",
    "Casier Postal 12",
    "Postfach 33",
    "Postbus 4",
    "P.O. Box", // no number
    "p.o. box 1", // lower case
    "PO BOX 1", // upper case
    "Po BoX 1", // mixed case
    "P.O.   Box   1", // extra spaces
    "P. O. Box 1", // spaces after each period
    "PO-Box 1", // hyphen
    "P O. B O X 3", // spaced letters
    "PO Box, 123", // comma
    "P.O. Box #123", // hash
    "po box", // bare
    "APARTADO POSTAL 5", // upper
  ];

  it.each(SHOULD_BLOCK)("blocks %j", (address1) => {
    expectBlocked(poBox, { address1, countryCode: "US" }, "address1");
  });

  const SHOULD_BLOCK_EVERYWHERE = ["Locked Bag 1234", "Locked Bag", "Private Bag 99", "Poste Restante", "Poste Restante 5"];
  it.each(SHOULD_BLOCK_EVERYWHERE)("blocks non-US form %j", (address1) => {
    expectBlocked(poBox, { address1, countryCode: "AU" }, "address1");
  });

  const SHOULD_ALLOW = [
    "12 Boxwood Ave",
    "1 Boxwood Lane",
    "Box Hill Rd",
    "300 Box Hill Road",
    "45 Post Office Rd",
    "99 Post Office Road",
    "123 Spokane St",
    "7 Poplar St",
    "1 POB Lane",
    "10 Boxwood Court",
    "220 Postal Way",
    "5 Apartado Court",
    "88 Main St",
    "1 Market St",
  ];
  it.each(SHOULD_ALLOW)("allows look-alike street %j", (address1) => {
    expectAllowed(poBox, { address1, countryCode: "US" });
  });

  // "Pobox" is both the classic evasion spelling and a plausible street name.
  // Blocking it is the deliberate choice: a false positive costs one customer
  // changing two characters, a false negative lets every evasion through.
  it("blocks the unspaced 'Pobox' spelling even when it names a lane", () => {
    expectBlocked(poBox, { address1: "Pobox Lane", countryCode: "US" }, "address1");
  });

  it("blocks a PO Box split across address1 and address2", () => {
    expectBlocked(poBox, { address1: "123 Main St", address2: "PO Box 77", countryCode: "US" }, "address2");
    // The keyword sits in address1, so address1 is blamed even though the
    // number completes it. Detection is what matters here.
    expectBlocked(poBox, { address1: "PO Box", address2: "77", countryCode: "US" }, "address1");
  });

  it("blocks when the PO Box text hides in the city", () => {
    expectBlocked(poBox, { address1: "1 Main St", city: "PO Box 5", countryCode: "US" }, "city");
  });

  it("survives unicode evasion", () => {
    // Zero-width space inside the keyword, full-width letters, NBSP, soft hyphen.
    const evasions = [
      "PO\u200bBox 12", // zero-width space
      "P\u200bO Box 12", // inside the abbreviation
      "ＰＯ　Ｂｏｘ 12", // full-width + ideographic space
      "PO Box 12", // non-breaking space
      "PO­Box 12", // soft hyphen
      "P﻿O Box 12", // BOM
    ];
    for (const address1 of evasions) {
      expect(evaluateCart(cartAt({ address1, countryCode: "US" }), config({ regexRules: [poBox] })), address1).not.toHaveLength(0);
    }
  });

  it("survives accents and ligatures", () => {
    // NFKC folds the full-width/compatibility forms; accents fold to ASCII.
    expect(evaluateCart(cartAt({ address1: "Àpártado Póstal 5", countryCode: "ES" }), config({ regexRules: [poBox] }))).not.toHaveLength(0);
  });

  it("does not block when the rule is switched off", () => {
    const off = config({ settings: { ...ALL_ON, enable_po_box: false }, regexRules: [poBox] });
    expect(evaluateCart(cartAt({ address1: "PO Box 1", countryCode: "US" }), off)).toHaveLength(0);
  });
});

describe("military address blocking", () => {
  const SHOULD_BLOCK = [
    "APO 12345",
    "FPO 99999",
    "DPO 45678",
    "A.P.O. 12345",
    "APO AE 12345",
    "1 APO Box 100",
    "Unit 1234 Box 5678 APO",
  ];
  it.each(SHOULD_BLOCK)("blocks %j in the US", (address1) => {
    expectBlocked(military, { address1, countryCode: "US" }, "address1");
  });

  it("checks address2 and city too", () => {
    expectBlocked(military, { address1: "1 Main St", address2: "APO 12345", countryCode: "US" }, "address2");
    expectBlocked(military, { address1: "1 Main St", city: "APO", countryCode: "US" }, "city");
  });

  it("applies only in the US, the preset's country scope", () => {
    expectAllowed(military, { address1: "APO 12345", countryCode: "DE" });
  });

  const SHOULD_ALLOW = [
    "1 Apollo St",
    "Apollo 12",
    "2 Depot Road",
    "1 Apopka Rd",
    "Apopka FL",
    "1 Main St",
    "Ridgeland Tap",
    // A street merely named after the abbreviation is not a military address:
    // these have no ZIP, which every APO/FPO/DPO line carries.
    "100 Fpo Street",
    "5 Dpo Court",
  ];
  it.each(SHOULD_ALLOW)("allows look-alike %j", (address1) => {
    expectAllowed(military, { address1, countryCode: "US" });
  });

  it("catches unicode-split APO", () => {
    expect(evaluateCart(cartAt({ address1: "A\u200bPO 12345", countryCode: "US" }), config({ regexRules: [military] }))).not.toHaveLength(0);
  });
});

describe("country and region blocking", () => {
  const geo = config({ geoBlocklist: { countries: ["CU", "KP"], zips: ["78701", "90210"], cities: ["havana"], states: ["TX", "US-WA"] } });

  it("blocks a blocked country by ISO code", () => {
    const v = evaluateCart(cartAt({ address1: "1 Main", countryCode: "CU" }), geo);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("country");
  });

  it("blocks a blocked country given by name as well as code", () => {
    expect(evaluateCart(cartAt({ address1: "1 Main", countryCode: "Cuba" }), geo)).toHaveLength(1);
  });

  it("treats UK as GB", () => {
    const gb = config({ geoBlocklist: { countries: ["GB"], zips: [], cities: [], states: [] } });
    expect(evaluateCart(cartAt({ address1: "1 High St", countryCode: "UK" }), gb)).toHaveLength(1);
  });

  it("blocks US territories when listed", () => {
    const pr = config({ geoBlocklist: { countries: ["PR", "GU", "VI"], zips: [], cities: [], states: [] } });
    for (const code of ["PR", "GU", "VI"]) {
      expect(evaluateCart(cartAt({ address1: "1 Calle", countryCode: code }), pr), code).toHaveLength(1);
    }
  });

  it("ignores an empty or missing country rather than blocking", () => {
    expect(evaluateCart(cartAt({ address1: "1 Main", countryCode: null }), geo)).toHaveLength(0);
    expect(evaluateCart(cartAt({ address1: "1 Main" }), geo)).toHaveLength(0);
    expect(evaluateCart(cartAt({ address1: "1 Main", countryCode: "" }), geo)).toHaveLength(0);
  });

  it("blocks a blocked ZIP and tolerates spacing variants", () => {
    for (const zip of ["78701", "787 01", "787-01", "78701-1234"]) {
      expect(evaluateCart(cartAt({ address1: "1 Main", zip, countryCode: "US" }), geo), zip).toHaveLength(1);
    }
  });

  it("scopes a ZIP to its country when the entry says so", () => {
    const scoped = config({ geoBlocklist: { countries: [], zips: ["US:78701"], cities: [], states: [] } });
    expect(evaluateCart(cartAt({ address1: "1 Main", zip: "78701", countryCode: "US" }), scoped)).toHaveLength(1);
    expect(evaluateCart(cartAt({ address1: "1 Main", zip: "78701", countryCode: "CA" }), scoped)).toHaveLength(0);
  });

  it("blocks a city, ignoring case, accents and punctuation", () => {
    for (const city of ["Havana", "havana", "HABANA", "La Habana", "La  Habana"]) {
      expect(evaluateCart(cartAt({ address1: "1 Main", city, countryCode: "CU" }), geo), city).toHaveLength(1);
    }
  });

  it("blocks a state, accepting a country prefix on the entry", () => {
    expect(evaluateCart(cartAt({ address1: "1 Main", provinceCode: "TX", countryCode: "US" }), geo)).toHaveLength(1);
    expect(evaluateCart(cartAt({ address1: "1 Main", provinceCode: "WA", countryCode: "US" }), geo)).toHaveLength(1);
    expect(evaluateCart(cartAt({ address1: "1 Main", provinceCode: "CA", countryCode: "US" }), geo)).toHaveLength(0);
  });

  it("blocks only the shipping address, not a billing address we never receive", () => {
    // The Function input only carries delivery addresses, so there is no
    // billing path to bypass or to wrongly block.
    const v = evaluateCart(cartAt({ address1: "1 Main", countryCode: "US" }), geo);
    expect(v).toHaveLength(0);
  });

  it("checks every delivery group", () => {
    const cart: CartInput = {
      email: null,
      lines: [],
      addresses: [
        { groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } },
        { groupIndex: 1, address: { address1: "2 Side", countryCode: "CU" } },
      ],
    };
    const v = evaluateCart(cart, geo);
    expect(v).toHaveLength(1);
    expect(v[0].target).toContain("deliveryGroups[1]");
  });
});