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
  /** The language the app should render in. */
  language: Language;
  /** True once the merchant has picked a language themselves. */
  chosen: boolean;
  /** True when the choice came from the admin/browser rather than the shop. */
  detected: boolean;
};

/** Reads the merchant's saved choice for a shop, if there is one. */
export async function readChosenLanguage(shop: string | undefined): Promise<Language | null> {
  if (!shop) return null;
  try {
    const row = await prisma.shopPreference.findUnique({ where: { shop } });
    return normalizeLanguage(row?.language);
  } catch (error) {
    // A missing table must never block the app from loading in English.
    console.warn("[CartGuard] Could not read the saved language preference:", error);
    return null;
  }
}

/**
 * Saves the merchant's explicit choice. Pass `null` to go back to following
 * the admin locale.
 */
export async function writeChosenLanguage(shop: string, language: Language | null): Promise<void> {
  if (!shop) return;
  try {
    await prisma.shopPreference.upsert({
      where: { shop },
      create: { shop, language, languageChosenAt: language ? new Date() : null },
      update: { language, languageChosenAt: language ? new Date() : null },
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
  const chosen = await readChosenLanguage(options.shop);
  if (chosen) return { language: chosen, chosen: true, detected: false };

  const url = new URL(request.url);
  const requested = normalizeLanguage(url.searchParams.get("locale"));
  if (requested) return { language: requested, chosen: false, detected: true };

  // Shopify sends the admin user's chosen locale on GET requests to embedded apps.
  const fromAdmin = normalizeLanguage(options.sessionLocale);
  if (fromAdmin) return { language: fromAdmin, chosen: false, detected: true };

  const fromBrowser = pickLanguage(acceptLanguageTags(request.headers.get("accept-language")));
  if (fromBrowser !== DEFAULT_LANGUAGE) {
    return { language: fromBrowser, chosen: false, detected: true };
  }

  return { language: resolveLanguage(null), chosen: false, detected: false };
}