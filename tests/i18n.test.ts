/**
 * Translation catalog checks. A missing key must never reach the UI: English is
 * the runtime fallback, so a gap shows up as an English sentence in the middle
 * of a German page, which no runtime error would ever catch.
 */

import { describe, expect, it } from "vitest";
import en from "../app/i18n/messages/en.json";

import { checkLocales } from "../scripts/check-locales.mjs";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_FLAGS,
  LANGUAGE_NAMES,
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
  pickLanguage,
  resolveLanguage,
} from "../app/i18n/locales";
import {
  catalogFor,
  formatCurrency,
  formatDateTime,
  formatList,
  formatNumber,
  formatRelativeTime,
  plural,
  translate,
} from "../app/i18n/catalog";

/** Placeholders a translated string must keep, e.g. `{count}`. */
const placeholders = (template: string) => [...String(template).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const flatten = (node: unknown, prefix = ""): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(node as Record<string, string>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") for (const [child, text] of flatten(value, path)) out.set(child, text);
    else out.set(path, value as string);
  }
  return out;
};

const english = flatten(en);

describe("locale catalogs", () => {
  it("every shipped language has a complete catalog", () => {
    const { problems } = checkLocales();
    expect(problems).toEqual([]);
  });

  it("ships exactly the required plus researched languages", () => {
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(["de", "en", "es", "fr", "it", "ja", "nl", "pt-BR", "sv", "zh-CN"]);
  });

  it("has no empty English strings", () => {
    for (const [key, value] of english) {
      expect(value.trim(), key).not.toBe("");
      expect(typeof value, key).toBe("string");
    }
  });

  it("never renders a raw key", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of english.keys()) {
        const message = translate(language, key as keyof typeof en);
        expect(message, `${language}/${key}`).not.toBe(key);
        expect(message.trim(), `${language}/${key}`).not.toBe("");
      }
    }
  });

  it("keeps every placeholder through translation", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      if (language === DEFAULT_LANGUAGE) continue;
      const catalog = catalogFor(language);
      for (const [key, source] of english) {
        const translated = catalog[key];
        if (typeof translated !== "string") continue;
        expect(placeholders(translated), `${language}/${key}`).toEqual(placeholders(source));
      }
    }
  });

  it("has a native name and a flag for every language", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(LANGUAGE_NAMES[language], language).toBeTruthy();
      expect(LANGUAGE_FLAGS[language], language).toMatch(/^[a-z]{2,3}$/);
      // Names must be written in their own language, not translated to English.
      expect(LANGUAGE_NAMES[language], language).not.toBe(language);
    }
    expect(LANGUAGE_NAMES.en).toBe("English");
    expect(LANGUAGE_NAMES["zh-CN"]).toBe("简体中文");
    expect(LANGUAGE_NAMES.ja).toBe("日本語");
    expect(LANGUAGE_NAMES["pt-BR"]).toContain("Brasil");
  });
});

describe("translating", () => {
  it("returns the requested language", () => {
    expect(translate("de", "nav.overview")).toBe("Übersicht");
    expect(translate("ja", "nav.settings")).toBe("設定");
  });

  it("interpolates placeholders", () => {
    expect(translate("en", "list.chip.remove", { value: "Canada" })).toBe("Remove Canada");
    expect(translate("en", "hero.protected.body", { rules: "address rules" })).toContain("address rules");
  });

  it("leaves an unknown placeholder visible rather than printing undefined", () => {
    expect(translate("en", "list.chip.remove", { nope: "x" })).toBe("Remove {value}");
  });

  it("never interpolates a placeholder a catalog did not declare", () => {
    // `{email}` appears inside a German sentence for a different reason, so a
    // value for it must be passed through, never assumed.
    expect(translate("de", "settings.help.email", {})).toContain("{email}");
  });
});

describe("language detection", () => {
  it("accepts a language we ship", () => {
    expect(normalizeLanguage("de")).toBe("de");
    expect(normalizeLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeLanguage("pt-BR")).toBe("pt-BR");
  });

  it("narrows a regional admin locale to the shipped language", () => {
    expect(normalizeLanguage("de-AT")).toBe("de");
    expect(normalizeLanguage("fr_CA")).toBe("fr");
    expect(normalizeLanguage("en-GB")).toBe("en");
  });

  it("maps an unshipped admin language onto the closest one we have", () => {
    expect(normalizeLanguage("pt-PT")).toBe("pt-BR");
    expect(normalizeLanguage("zh-TW")).toBe("zh-CN");
    expect(normalizeLanguage("da")).toBe("sv");
    expect(normalizeLanguage("nb-NO")).toBe("sv");
  });

  it("falls back to English for anything unknown or empty", () => {
    expect(normalizeLanguage("xx")).toBeNull();
    expect(normalizeLanguage("")).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
    expect(resolveLanguage("xx")).toBe("en");
    expect(resolveLanguage(undefined)).toBe("en");
  });

  it("picks the first supported language from a browser header list", () => {
    expect(pickLanguage(["pl-PL", "pl", "de-AT", "de"])).toBe("de");
    expect(pickLanguage(["xx", "ja"])).toBe("ja");
    expect(pickLanguage(["xx", "yy"])).toBe("en");
  });
});

describe("plurals and formatting", () => {
  it("uses one form for languages without plurals", () => {
    expect(plural("ja", { other: "{count}件" }, 1)).toBe("1件");
    expect(plural("ja", { other: "{count}件" }, 5)).toBe("5件");
    expect(plural("zh-CN", { other: "{count} 件" }, 2)).toBe("2 件");
  });

  it("uses the right form for languages with them", () => {
    const forms = { one: "{count} field", other: "{count} fields" };
    expect(plural("en", forms, 1)).toBe("1 field");
    expect(plural("en", forms, 3)).toBe("3 fields");
    expect(plural("de", { one: "{count} Feld", other: "{count} Felder" }, 3)).toBe("3 Felder");
    // French treats 0 as singular, unlike English.
    expect(plural("fr", { one: "{count} champ", other: "{count} champs" }, 0)).toBe("0 champ");
  });

  it("formats numbers per locale", () => {
    expect(formatNumber("en", 1234)).toBe("1,234");
    expect(formatNumber("de", 1234)).toBe("1.234");
    expect(formatNumber("ja", 1234)).toBe("1,234");
  });

  it("formats currency, falling back when there is no code", () => {
    expect(formatCurrency("en", 12.5, "USD")).toContain("12.50");
    expect(formatCurrency("de", 1234.5, "EUR")).toMatch(/1\.234,50/);
    expect(formatCurrency("en", 1234.5)).toBe("1,234.5");
  });

  it("formats dates and relative time in the chosen language", () => {
    const when = new Date("2026-02-01T14:30:00Z");
    expect(formatDateTime("en", when)).toMatch(/2026/);
    expect(formatDateTime("ja", when)).toContain("2026");
    expect(formatRelativeTime("en", Date.now() - 3 * 86400000)).toBe("3 days ago");
    expect(formatDateTime("en", "not a date")).toBe("");
  });

  it("joins lists the way each language expects", () => {
    expect(formatList("en", ["a", "b", "c"])).toBe("a, b, and c");
    expect(formatList("ja", ["a", "b"])).toContain("a");
  });
});