import { afterEach, describe, expect, it } from "vitest";
import { ADDRESS_PRESETS, isRiskyPattern } from "../extensions/cartguard-validator/src/rules";
import { MerchantFacingError, friendlyErrorMessage } from "../app/lib/admin-api.server";
import { canUseMockAdmin } from "../app/lib/admin-mock.server";
import { validateRuleConfig } from "../app/lib/cartguard.server";
import {
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  pickLanguage,
  resolveLanguage,
} from "../app/i18n/locales";

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
    for (const bad of ["abc", "", 0, -3, 1.5, null]) {
      expect(validateRuleConfig({ quantityLimits: { bulk: bad } }).errors.quantity, String(bad)).toBeTruthy();
      expect(validateRuleConfig({ quantityLimits: { bulk: { max: bad } } }).errors.quantity, String(bad)).toBeTruthy();
    }
  });
});

describe("language normalisation against prototype keys", () => {
  // `?locale=constructor` used to return the `Object` constructor: the alias
  // table was a normal object literal, so indexing it walked the prototype
  // chain. The function was truthy, so it passed every downstream
  // `if (language)` guard and reached Prisma as a `language` column, while
  // React dropped the `lang` attribute entirely (WCAG 3.1.1).
  const prototypeKeys = [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__proto__",
    "prototype",
  ];

  it("never returns a function or object for a prototype key", () => {
    for (const key of prototypeKeys) {
      const result = normalizeLanguage(key);
      expect(result, key).toBeNull();
    }
  });

  it("does not let a prototype key resolve through pickLanguage", () => {
    expect(pickLanguage(prototypeKeys)).toBe(DEFAULT_LANGUAGE);
    expect(pickLanguage(["__proto__", "de"])).toBe("de");
  });

  it("still resolves real languages and aliases", () => {
    expect(normalizeLanguage("de-AT")).toBe("de");
    expect(normalizeLanguage("pt")).toBe("pt-BR");
    expect(normalizeLanguage("EN")).toBe("en");
    expect(resolveLanguage("constructor")).toBe(DEFAULT_LANGUAGE);
  });

  it("survives malformed and non-string input", () => {
    for (const raw of ["", "   ", "-", "---", "-en", "*", "en;q", "de;q=abc", "a".repeat(5000)]) {
      expect(normalizeLanguage(raw), JSON.stringify(raw)).toBeNull();
    }
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
    // Guards against a non-string reaching the resolver from a typed caller.
    expect(normalizeLanguage(123 as unknown as string)).toBeNull();
    expect(normalizeLanguage({} as unknown as string)).toBeNull();
  });
});

describe("address preset names against prototype keys", () => {
  // `preset` is merchant-editable JSON, and the lookup used `in`, which also
  // reports true for inherited keys.
  it("does not treat inherited properties as presets", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(Object.hasOwn(ADDRESS_PRESETS, key), key).toBe(false);
    }
    expect(Object.hasOwn(ADDRESS_PRESETS, "po_box")).toBe(true);
  });

  it("accepts a hostile preset without crashing validation", () => {
    for (const preset of ["constructor", "__proto__", "toString"]) {
      expect(() =>
        validateRuleConfig({ regexRules: [{ pattern: "abc", preset }] } as never),
      ).not.toThrow();
    }
  });
});
