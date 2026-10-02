/**
 * The languages CartGuard ships in, and how one is chosen.
 *
 * Codes match the ones Polaris uses in `@shopify/polaris/locales/*.json`, so a
 * single code drives both this app's catalog and Polaris's own component
 * translations. English is the default and the fallback for any missing key.
 */

export const SUPPORTED_LANGUAGES = ["en", "de", "fr", "es", "pt-BR", "zh-CN", "ja", "it", "nl", "sv"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** The language used for any missing key, and the default before a choice. */
export const DEFAULT_LANGUAGE: Language = "en";

/**
 * Each language is shown in its own name (never in English) so a merchant who
 * cannot read English can still find their language, which is what Shopify's
 * own language picker does.
 */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  "zh-CN": "简体中文",
  ja: "日本語",
  it: "Italiano",
  nl: "Nederlands",
  sv: "Svenska",
};

/**
 * A flag is decoration next to a language name, never the label itself: a
 * language is not a country (English is not only the US, Spanish is not only
 * Spain). The flag is only a quick scanning aid, and it is `aria-hidden` in the
 * UI. SVG rather than emoji because emoji flags render as plain letters on
 * Windows.
 */
export const LANGUAGE_FLAGS: Record<Language, string> = {
  en: "us",
  de: "de",
  fr: "fr",
  es: "es",
  "pt-BR": "br",
  "zh-CN": "cn",
  ja: "jp",
  it: "it",
  nl: "nl",
  sv: "se",
};

const isSupported = (value: string): value is Language => (SUPPORTED_LANGUAGES as readonly string[]).includes(value);

/**
 * Admin locales that are not shipped map onto the closest language we do have,
 * so a merchant whose admin is in Danish or Polish still sees translated
 * copy rather than a raw key.
 *
 * Null prototype: this table is indexed with attacker-controlled strings from
 * `?locale=`, and a normal object literal would answer `ALIASES["constructor"]`
 * with the `Object` constructor — a function that is truthy, so it would sail
 * through every `if (language)` guard downstream and reach the database.
 */
const ALIASES: Record<string, Language> = Object.assign(Object.create(null) as Record<string, Language>, {
  "pt-pt": "pt-BR",
  pt: "pt-BR",
  zh: "zh-CN",
  "zh-hans": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-tw": "zh-CN",
  "zh-hant": "zh-CN",
  nb: "sv",
  no: "sv",
  da: "sv",
  fi: "sv",
  cs: "de",
  pl: "de",
  tr: "fr",
  th: "ja",
  vi: "ja",
});

/**
 * Turns anything the admin, a URL or a browser might send us into a language
 * CartGuard actually has: "de-AT" and "de_AT" both become "de", and anything
 * unknown falls back to English.
 */
export function normalizeLanguage(raw: string | null | undefined): Language | null {
  if (typeof raw !== "string") return null;
  const tag = raw.trim().replace(/_/g, "-");
  if (!tag) return null;

  if (isSupported(tag)) return tag;

  const exact = lookupAlias(tag);
  if (exact) return exact;

  const base = tag.split("-")[0];
  const lowered = base.toLowerCase();
  if (isSupported(lowered)) return lowered;
  return lookupAlias(lowered);
}

/**
 * Reads the alias table without ever returning anything that is not a Language.
 *
 * The `isSupported` re-check is deliberate belt-and-braces: every caller treats
 * a truthy result as a valid language and persists it, so this function is the
 * single place that decides what is allowed in, and it must be impossible for a
 * stray prototype key to widen that.
 */
function lookupAlias(tag: string): Language | null {
  const exact = ALIASES[tag] ?? ALIASES[tag.toLowerCase()];
  return isSupported(exact) ? exact : null;
}

/** Like `normalizeLanguage`, but always returns something usable. */
export function resolveLanguage(raw: string | null | undefined): Language {
  return normalizeLanguage(raw) ?? DEFAULT_LANGUAGE;
}

/** Picks the best supported language from a list, e.g. `Accept-Language`. */
export function pickLanguage(preferred: readonly string[]): Language {
  for (const entry of preferred) {
    const language = normalizeLanguage(entry);
    if (language) return language;
  }
  return DEFAULT_LANGUAGE;
}

export type LanguageOption = {
  value: Language;
  /** Native language name, e.g. "Deutsch". */
  label: string;
  /** SVG flag code from `flag-icons`, e.g. "de". Decorative only. */
  flag: string;
};

/** Languages in their own script first, English last as the safe default. */
export const LANGUAGE_OPTIONS: LanguageOption[] = [
  ...SUPPORTED_LANGUAGES.filter((code) => code !== DEFAULT_LANGUAGE).map((code) => ({
    value: code,
    label: LANGUAGE_NAMES[code],
    flag: LANGUAGE_FLAGS[code],
  })),
  { value: DEFAULT_LANGUAGE, label: LANGUAGE_NAMES[DEFAULT_LANGUAGE], flag: LANGUAGE_FLAGS[DEFAULT_LANGUAGE] },
];
