/**
 * Server-side resolution of the app language.
 *
 * Precedence, highest first:
 *   1. the language the merchant explicitly chose (ShopPreference.language)
 *   2. a `?locale=` query parameter (the language switcher, and a way to
 *      preview a language)
 *   3. the Shopify admin locale, which embedded apps receive in the `locale`
 *      request parameter and in the session's `locale` field
 *   4. the browser's `Accept-Language`, used only in local demo mode where no
 *      Shopify session exists
 *   5. English
 *
 * The result is resolved here, on the server, so the first render already has
 * the right language. That is what prevents a flash of the wrong language and
 * any hydration mismatch.
 */

import prisma from "../db.server";
import { DEFAULT_LANGUAGE, type Language, normalizeLanguage, pickLanguage, resolveLanguage } from "./locales";

export type ResolvedLanguage = {
  /** The language the app should render in. Always one CartGuard ships. */
  language: Language;
  /** True once the merchant has answered the first-launch picker, either way. */
  chosen: boolean;
  /** True when the language came from the admin/browser rather than a choice. */
  detected: boolean;
};

export type SavedLanguage = {
  /** The language they picked, or null when following the admin locale. */
  language: Language | null;
  /** True once they have answered the picker, including by skipping it. */
  asked: boolean;
};

/**
 * Reads the merchant's language state for a shop.
 *
 * `asked` is tracked separately from `language` on purpose: skipping the picker
 * is an answer, and if it left no trace the modal would reappear on every
 * single page load.
 */
export async function readSavedLanguage(shop: string | undefined): Promise<SavedLanguage> {
  if (!shop) return { language: null, asked: false };
  try {
    const row = await prisma.shopPreference.findUnique({ where: { shop } });
    return { language: normalizeLanguage(row?.language), asked: Boolean(row?.languageChosenAt) };
  } catch (error) {
    // A missing table must never block the app from loading in English.
    console.warn("[CartGuard] Could not read the saved language preference:", error);
    return { language: null, asked: false };
  }
}

/**
 * Records the merchant's answer to the language picker. Pass `null` to follow
 * the admin locale again, which is also what skipping does. Either way
 * `languageChosenAt` is stamped, so the picker does not ask twice.
 */
export async function writeChosenLanguage(shop: string, language: Language | null): Promise<void> {
  if (!shop) return;
  try {
    const now = new Date();
    await prisma.shopPreference.upsert({
      where: { shop },
      create: { shop, language, languageChosenAt: now },
      update: { language, languageChosenAt: now },
    });
  } catch (error) {
    console.error("[CartGuard] Could not save the language preference:", error);
    throw error;
  }
}

/** Parses `Accept-Language: de-AT,de;q=0.9,en;q=0.8` into a list of tags. */
function acceptLanguageTags(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const quality = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
      return { tag: tag.trim(), weight: quality ? Number.parseFloat(quality.slice(2)) || 0 : 1 };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.tag);
}

export type ResolveOptions = {
  /** The shop domain, used to read the saved preference. */
  shop?: string;
  /** The admin user's locale from the session, if authenticated. */
  sessionLocale?: string | null;
};

/**
 * Works out which language to render. Runs on the server for every document
 * request, so the answer is always available to both SSR and hydration.
 */
export async function resolveRequestLanguage(request: Request, options: ResolveOptions = {}): Promise<ResolvedLanguage> {
  const saved = await readSavedLanguage(options.shop);
  if (saved.language) return { language: saved.language, chosen: true, detected: false };

  const url = new URL(request.url);
  const requested = normalizeLanguage(url.searchParams.get("locale"));
  if (requested) return { language: requested, chosen: saved.asked, detected: !saved.asked };

  // Shopify sends the admin user's chosen locale on GET requests to embedded apps.
  const fromAdmin = normalizeLanguage(options.sessionLocale);
  if (fromAdmin) return { language: fromAdmin, chosen: saved.asked, detected: !saved.asked };

  const fromBrowser = pickLanguage(acceptLanguageTags(request.headers.get("accept-language")));
  if (fromBrowser !== DEFAULT_LANGUAGE) {
    return { language: fromBrowser, chosen: saved.asked, detected: !saved.asked };
  }

  return { language: resolveLanguage(null), chosen: saved.asked, detected: false };
}