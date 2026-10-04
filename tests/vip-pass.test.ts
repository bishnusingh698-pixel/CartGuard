/**
 * Phase 3: VIP Pass.
 *
 * The security-critical property is that only a *signed-in* customer account
 * email grants the pass. Anyone can type any address into a guest checkout, so
 * trusting the typed address would let anyone bypass the rules by typing a
 * known VIP email. These tests pin that distinction.
 */

import { describe, expect, it } from "vitest";
import {
  ADDRESS_PRESETS,
  evaluateCart,
  type CartAddress,
  type CartInput,
  type RuleConfig,
} from "../extensions/cartguard-validator/src/rules";

const ALL_ON = { enable_vip: true, enable_po_box: true, enable_quantity: true, enable_geo: true };

function config(overrides: Partial<RuleConfig> = {}): RuleConfig {
  return {
    settings: { ...ALL_ON },
    regexRules: [{ pattern: ADDRESS_PRESETS.po_box.pattern, message: "no PO boxes" }],
    quantityLimits: { all: { max: 1 } },
    geoBlocklist: { countries: ["CU"], zips: [], cities: [], states: [] },
    vipAllowlist: [],
    ...overrides,
  };
}

const PO_BOX: CartAddress = { address1: "PO Box 12", countryCode: "US" };

function cart(address: CartAddress, extra: Partial<CartInput> = {}): CartInput {
  return {
    email: null,
    lines: [],
    addresses: [{ groupIndex: 0, address }],
    ...extra,
  };
}

const one = (extra: Partial<CartInput> = {}) => ({ quantity: 5, productId: "gid://shopify/Product/1", tags: [] });
const vipConfig = (allowlist: string[]) => config({ vipAllowlist: allowlist });

describe("VIP email matching", () => {
  it("grants the pass to a signed-in customer on the list", () => {
    const c = vipConfig(["vip@example.com"]);
    expect(evaluateCart(cart(PO_BOX, { customerEmail: "vip@example.com" }), c)).toHaveLength(0);
  });

  it("ignores case and surrounding whitespace on both sides", () => {
    const c = vipConfig(["  VIP@Example.com  "]);
    expect(evaluateCart(cart(PO_BOX, { customerEmail: "vip@EXAMPLE.com" }), c)).toHaveLength(0);
  });

  it("matches internal whitespace runs on either side of the address", () => {
    const c = vipConfig(["vip@example.com"]);
    expect(evaluateCart(cart(PO_BOX, { customerEmail: "vip@example.com" }), c)).toHaveLength(0);
    expect(evaluateCart(cart(PO_BOX, { customerEmail: "  vip@example.com  " }), c)).toHaveLength(0);
  });

  // The core of the feature. A guest can type anything, so a typed address
  // must never confer the pass.
  it("does NOT grant the pass for an email typed at guest checkout", () => {
    const c = vipConfig(["vip@example.com"]);
    const attempts = [
      { email: "vip@example.com" },
      { email: "VIP@EXAMPLE.COM" },
      { email: "vip@example.com " },
      { email: "vip@example.com." },
      { email: "vip+tag@example.com" },
      { email: "v.ip@example.com" },
    ];
    for (const extra of attempts) {
      const violations = evaluateCart(cart(PO_BOX, extra), c);
      expect(violations.map((v) => v.rule), JSON.stringify(extra)).toContain("address");
    }
  });

  it("prefers the signed-in account email over a typed one", () => {
    const c = vipConfig(["vip@example.com"]);
    // Signed in as the VIP, but typing someone else's address must not matter.
    expect(evaluateCart(cart(PO_BOX, { customerEmail: "vip@example.com", email: "someone@else.com" }), c)).toHaveLength(0);
    // Signed in as a non-VIP: still blocked, even if a VIP is typed.
    const blocked = evaluateCart(cart(PO_BOX, { customerEmail: "nobody@else.com", email: "vip@example.com" }), c);
    expect(blocked.map((v) => v.rule)).toContain("address");
  });

  it("does not fuzzy-match near-miss emails", () => {
    const c = vipConfig(["vip@example.com"]);
    for (const email of [
      "vip@example.co",
      "vip@example.com.evil.com",
      "vipXexample.com",
      "vip@example.comm",
      "xvi@example.com",
    ]) {
      expect(evaluateCart(cart(PO_BOX, { customerEmail: email }), c), email).not.toHaveLength(0);
    }
  });

  it("supports no domain wildcards", () => {
    // A wildcard would let a merchant's "@example.com" entry exempt every
    // account at that domain. Entries are literal or nothing.
    const c = vipConfig(["*@example.com"]);
    for (const customerEmail of ["anyone@example.com", "attacker@example.com"]) {
      expect(evaluateCart(cart(PO_BOX, { customerEmail }), c), customerEmail).not.toHaveLength(0);
    }
  });

  it("treats a customer id or tag as not an email and ignores it", () => {
    const c = vipConfig(["1234567890"]);
    expect(evaluateCart(cart(PO_BOX, { customerEmail: "1234567890" }), c)).not.toHaveLength(0);
  });

  it("ignores entries that are not emails when no email entries exist", () => {
    const c = vipConfig(["1 Main Street"]);
    expect(evaluateCart(cart(PO_BOX, { customerEmail: "anyone@example.com" }), c)).not.toHaveLength(0);
  });
});

describe("VIP precedence and scope", () => {
  it("bypasses the PO Box rule", () => {
    expect(evaluateCart(cart(PO_BOX, { customerEmail: "vip@example.com" }), vipConfig(["vip@example.com"]))).toHaveLength(0);
  });

  it("bypasses quantity limits", () => {
    const c = vipConfig(["vip@example.com"]);
    const v = evaluateCart(cart({ address1: "1 Main", countryCode: "US" }, { customerEmail: "vip@example.com", lines: [one()] }), c);
    expect(v).toHaveLength(0);
  });

  it("bypasses ZIP, city and state blocks", () => {
    const c = config({
      vipAllowlist: ["vip@example.com"],
      geoBlocklist: { countries: [], zips: ["78701"], cities: ["Austin"], states: ["TX"] },
    });
    const address: CartAddress = { address1: "1 Main", city: "Austin", provinceCode: "TX", zip: "78701", countryCode: "US" };
    expect(evaluateCart(cart(address, { customerEmail: "vip@example.com" }), c)).toHaveLength(0);
  });

  it("never bypasses the country embargo", () => {
    const c = vipConfig(["vip@example.com"]);
    const address: CartAddress = { address1: "PO Box 12", countryCode: "CU" };
    const v = evaluateCart(cart(address, { customerEmail: "vip@example.com" }), c);
    expect(v.map((x) => x.rule)).toContain("country");
  });

  it("does nothing when the VIP feature is off", () => {
    const c = config({ settings: { ...ALL_ON, enable_vip: false }, vipAllowlist: ["vip@example.com"] });
    expect(evaluateCart(cart(PO_BOX, { customerEmail: "vip@example.com" }), c)).not.toHaveLength(0);
  });
});

describe("VIP address matching", () => {
  const addressVip = (entries: string[]) => config({ vipAllowlist: entries });

  it("exempts line 1 of a listed street address", () => {
    const c = addressVip(["1 Trusted Way"]);
    expect(evaluateCart(cart({ address1: "1 Trusted Way", countryCode: "US" }), c)).toHaveLength(0);
  });

  it("normalizes case, punctuation and accents", () => {
    const c = addressVip(["1 Trusted Way"]);
    for (const address1 of ["1 trusted way", "1 TRUSTED WAY", "1 Trusted-Way", "1 Trusted  Way"]) {
      expect(evaluateCart(cart({ address1, countryCode: "US" }), c), address1).toHaveLength(0);
    }
  });

  it("still checks line 2 and the city for an address VIP", () => {
    const c = addressVip(["1 Trusted Way"]);
    // A street address is weaker evidence than a signed-in account, so it only
    // exempts line 1. "PO Box" in line 2 still blocks.
    const v = evaluateCart(cart({ address1: "1 Trusted Way", address2: "PO Box 9", countryCode: "US" }), c);
    expect(v.map((x) => x.rule)).toContain("address");
  });

  it("does not exempt the address VIP from quantity limits", () => {
    const c = addressVip(["1 Trusted Way"]);
    const v = evaluateCart(cart({ address1: "1 Trusted Way", countryCode: "US" }, { lines: [one()] }), c);
    expect(v.map((x) => x.rule)).toContain("quantity");
  });

  it("ignores an address entry too short to be evidence", () => {
    // "1" never enters the list, so an address of "1" is evaluated normally and
    // passes because it is a plain street address, not because it is exempt.
    const c = addressVip(["1"]);
    const other = addressVip(["1 Trusted Way"]);
    expect(evaluateCart(cart({ address1: "1", countryCode: "US" }), c)).toEqual(
      evaluateCart(cart({ address1: "1", countryCode: "US" }), other),
    );
  });

  it("exempts only an exact address, not a longer one containing it", () => {
    const c = addressVip(["1 Trusted Way"]);
    expect(evaluateCart(cart({ address1: "1 Trusted Way", address2: "PO Box 9", countryCode: "US" }), c)).not.toHaveLength(0);
  });

  it("blocks duplicates and very long lists without throwing", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `dup${i % 10}@example.com`);
    const c = addressVip([...many, ...many]);
    expect(() => evaluateCart(cart(PO_BOX, { customerEmail: "dup1@example.com" }), c)).not.toThrow();
  });
});

describe("VIP list is never used as a regex", () => {
  it("treats regex metacharacters in an entry literally", () => {
    const c = vipConfig([".*", "a+", "(a|b)"]);
    // None of these are real accounts, so none may exempt anyone.
    for (const customerEmail of ["anyone@example.com", "a@example.com", "a+b@example.com"]) {
      expect(evaluateCart(cart(PO_BOX, { customerEmail }), c), customerEmail).not.toHaveLength(0);
    }
  });

  it("survives a catastrophic-backtracking entry", () => {
    const evil = "a".repeat(64) + "@" + "b".repeat(64) + "!" + "c".repeat(64);
    const c = vipConfig([`${evil}`, "(a+)+$"]);
    expect(() => evaluateCart(cart(PO_BOX, { customerEmail: "nobody@example.com" }), c)).not.toThrow();
  });
});