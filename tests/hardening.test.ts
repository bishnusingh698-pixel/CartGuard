import { afterEach, describe, expect, it } from "vitest";
import { ADDRESS_PRESETS, isRiskyPattern } from "../extensions/cartguard-validator/src/rules";
import { MerchantFacingError, friendlyErrorMessage } from "../app/lib/admin-api.server";
import { canUseMockAdmin } from "../app/lib/admin-mock.server";
import { validateDraftConfig } from "../app/lib/cartguard.server";

const emptyDraft = { regex_rules: "", quantity_limits: "", geo_blocklist: "", vip_allowlist: "" };

describe("demo mode gating (auth bypass regression)", () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it("is never available in production", () => {
    process.env.NODE_ENV = "production";
    expect(canUseMockAdmin(new Request("https://app.example/app/settings"))).toBe(false);
  });

  it("is never used for embedded requests", () => {
    process.env.NODE_ENV = "development";
    expect(canUseMockAdmin(new Request("https://app.example/app/settings?embedded=1"))).toBe(false);
    expect(canUseMockAdmin(new Request("https://app.example/app/settings?host=abc"))).toBe(false);
    expect(canUseMockAdmin(new Request("https://app.example/app/settings"))).toBe(true);
  });
});

describe("ReDoS guard", () => {
  it("flags quantified alternations, nested quantifiers and back-references", () => {
    for (const pattern of ["(a|a)*$", "(a|ab)+x", "(?:x|xy){2,}z", "(a+)+$", "(\\w+\\s?)*$", "(a)\\1"]) {
      expect(isRiskyPattern(pattern), pattern).toBe(true);
    }
  });

  it("accepts the built-in presets and ordinary patterns", () => {
    for (const { pattern } of Object.values(ADDRESS_PRESETS)) expect(isRiskyPattern(pattern), pattern).toBe(false);
    for (const pattern of ["calle 5", "\\bste\\s+\\d+", "(st|street)\\b", "warehouse 4b|mail drop"]) {
      expect(isRiskyPattern(pattern), pattern).toBe(false);
    }
  });
});

describe("merchant-facing errors", () => {
  it("never shows raw API errors", () => {
    const message = friendlyErrorMessage(new Error("Field 'validations' doesn't exist on type 'QueryRoot'"));
    expect(message).not.toMatch(/QueryRoot|Field/);
  });

  it("explains throttling", () => {
    expect(friendlyErrorMessage(new Error("Throttled"))).toMatch(/wait a minute/i);
  });

  it("keeps messages written for merchants", () => {
    expect(friendlyErrorMessage(new MerchantFacingError("Hello merchant."))).toBe("Hello merchant.");
  });
});

describe("quantity limit validation (server side)", () => {
  it("rejects limits that aren't whole numbers of at least 1", () => {
    for (const bad of ['{"bulk":"abc"}', '{"bulk":""}', '{"bulk":0}', '{"bulk":-3}', '{"bulk":1.5}']) {
      expect(validateDraftConfig({ ...emptyDraft, quantity_limits: bad }).quantity_limits, bad).toBeTruthy();
    }
  });
});
