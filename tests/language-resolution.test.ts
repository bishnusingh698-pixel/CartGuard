/**
 * Language resolution and persistence.
 *
 * The rules here are a precedence order, and the order is the whole point: a
 * saved choice has to beat the admin locale, which has to beat the browser.
 * These tests pin that order down, because a regression in it is invisible in
 * the UI and simply shows the wrong language to a merchant who set one.
 *
 * Prisma is replaced with a tiny in-memory store rather than a per-call mock,
 * because the logic under test is the ordering between the database read and
 * the request fallbacks, and a per-call mock would let that ordering change
 * without these tests noticing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type SavedRow = { language: string | null; languageChosenAt: Date | null };

const state: {
  row: SavedRow | null;
  failWith: Error | null;
  writes: Array<{ shop: string; language: string | null }>;
} = { row: null, failWith: null, writes: [] };

vi.mock("../app/db.server", () => ({
  default: {
    shopPreference: {
      findUnique: async () => {
        if (state.failWith) throw state.failWith;
        return state.row;
      },
      upsert: async ({ create }: { create: { shop: string; language: string | null } }) => {
        state.writes.push({ shop: create.shop, language: create.language });
        state.row = { language: create.language, languageChosenAt: new Date() };
        return state.row;
      },
    },
  },
}));

const { readSavedLanguage, resolveRequestLanguage, writeChosenLanguage } = await import("../app/i18n/language.server");

const request = (url: string, acceptLanguage?: string) =>
  new Request(url, acceptLanguage ? { headers: { "accept-language": acceptLanguage } } : undefined);

beforeEach(() => {
  state.row = null;
  state.failWith = null;
  state.writes = [];
});

describe("saved language", () => {
  it("reports a language and a choice as separate facts", async () => {
    state.row = { language: "de", languageChosenAt: new Date() };
    expect(await readSavedLanguage("shop.myshopify.com")).toEqual({ language: "de", asked: true });
  });

  it("treats skipping as answered, so the picker does not reappear", async () => {
    // Skipping writes a null language but still stamps the timestamp. If `asked`
    // were derived from the language, this would read as unanswered and the
    // first-launch modal would come back on every page load.
    state.row = { language: null, languageChosenAt: new Date() };
    expect(await readSavedLanguage("shop.myshopify.com")).toEqual({ language: null, asked: true });
  });

  it("never throws when the database is unavailable", async () => {
    state.failWith = new Error("database down");
    expect(await readSavedLanguage("shop.myshopify.com")).toEqual({ language: null, asked: false });
  });

  it("is unanswered without a shop, as in demo mode", async () => {
    expect(await readSavedLanguage(undefined)).toEqual({ language: null, asked: false });
  });

  it("ignores a stored language we no longer ship", async () => {
    state.row = { language: "kl", languageChosenAt: new Date() };
    expect((await readSavedLanguage("shop.myshopify.com")).language).toBeNull();
  });
});

describe("resolution order", () => {
  it("a saved language beats everything else", async () => {
    state.row = { language: "ja", languageChosenAt: new Date() };
    const result = await resolveRequestLanguage(request("https://x.app/app?locale=de"), { shop: "s.myshopify.com" });
    expect(result.language).toBe("ja");
  });

  it("falls back to the locale parameter when nothing is saved", async () => {
    const result = await resolveRequestLanguage(request("https://x.app/app?locale=de"), { shop: "s.myshopify.com" });
    expect(result).toEqual({ language: "de", chosen: false, detected: true });
  });

  it("uses the admin locale before the browser", async () => {
    const result = await resolveRequestLanguage(request("https://x.app/app", "fr-FR,fr;q=0.9"), {
      shop: "s.myshopify.com",
      sessionLocale: "es",
    });
    expect(result.language).toBe("es");
  });

  it("uses the browser when there is no admin locale", async () => {
    const result = await resolveRequestLanguage(request("https://x.app/app", "de-AT,de;q=0.9,en;q=0.8"), {
      shop: "s.myshopify.com",
    });
    expect(result.language).toBe("de");
  });

  it("honours Accept-Language weights rather than their order", async () => {
    const result = await resolveRequestLanguage(request("https://x.app/app", "en;q=0.2,sv;q=0.9"));
    expect(result.language).toBe("sv");
  });

  it("falls back to English, and never reports a detection", async () => {
    expect(await resolveRequestLanguage(request("https://x.app/app", "en-GB,en;q=0.9"))).toEqual({
      language: "en",
      chosen: false,
      detected: false,
    });
  });

  it("does not treat an English browser as a detection worth prompting for", async () => {
    // English is the default, so prompting a merchant who reads nothing but
    // English adds a step for no benefit.
    const result = await resolveRequestLanguage(request("https://x.app/app", "en-US,en;q=0.9"));
    expect(result.detected).toBe(false);
  });

  it("marks a skipped shop as answered even when it now renders English", async () => {
    state.row = { language: null, languageChosenAt: new Date() };
    const result = await resolveRequestLanguage(request("https://x.app/app"), { shop: "s.myshopify.com" });
    expect(result).toEqual({ language: "en", chosen: true, detected: false });
  });

  it("still resolves without a shop, as in demo mode", async () => {
    const result = await resolveRequestLanguage(request("https://x.app/app", "it;q=0.9"));
    expect(result.language).toBe("it");
  });
});

describe("saving a choice", () => {
  it("records the language and stamps it as answered", async () => {
    await writeChosenLanguage("s.myshopify.com", "de");
    expect(state.writes).toEqual([{ shop: "s.myshopify.com", language: "de" }]);
  });

  it("clears the language but still stamps the answer when going back to the admin locale", async () => {
    await writeChosenLanguage("s.myshopify.com", null);
    expect(state.writes).toEqual([{ shop: "s.myshopify.com", language: null }]);
    expect((await readSavedLanguage("s.myshopify.com")).asked).toBe(true);
  });
});
