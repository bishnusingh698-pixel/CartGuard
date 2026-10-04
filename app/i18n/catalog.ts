/**
 * Message lookup and formatting.
 *
 * English is the source of truth: `MessageKey` is derived from its catalog, so
 * a key that exists only in a translation is a compile error rather than a
 * silently broken string. Missing keys at runtime fall back to English, and
 * only then to the key itself, which the catalog test guards against.
 */

import { DEFAULT_LANGUAGE, type Language } from "./locales";
import en from "./messages/en.json";
import de from "./messages/de.json";
import fr from "./messages/fr.json";
import es from "./messages/es.json";
import ptBR from "./messages/pt-BR.json";
import zhCN from "./messages/zh-CN.json";
import ja from "./messages/ja.json";
import it from "./messages/it.json";
import nl from "./messages/nl.json";
import sv from "./messages/sv.json";

export type { Language } from "./locales";
export { DEFAULT_LANGUAGE } from "./locales";

/** Flat dot-separated catalog, e.g. `"rules.save.button"`. */
export type Messages = Record<string, string>;

/** Every key a translator must provide, taken from the English catalog. */
export type MessageKey = keyof typeof en;

const CATALOGS: Record<Language, Messages> = {
  en,
  de,
  fr,
  es,
  "pt-BR": ptBR,
  "zh-CN": zhCN,
  ja,
  it,
  nl,
  sv,
};

export type TranslateValues = Record<string, string | number>;

/** Interpolates `{name}` placeholders. Missing values are left visible. */
function interpolate(template: string, values?: TranslateValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

/**
 * Looks up a message in the requested language, then English. `values`
 * interpolates `{placeholders}`.
 */
export function translate(language: Language, key: MessageKey, values?: TranslateValues): string {
  const catalog = CATALOGS[language] ?? CATALOGS[DEFAULT_LANGUAGE];
  const template = catalog[key] ?? CATALOGS[DEFAULT_LANGUAGE][key];
  return interpolate(template ?? key, values);
}

/**
 * Picks the right plural form using the locale's own rules, so languages with
 * one form (Japanese, Chinese) and languages with more (French) are correct.
 * `forms` is indexed by plural category: one, other, and so on.
 */
export function plural(
  language: Language,
  forms: Partial<Record<Intl.LDMLPluralRule, string>>,
  count: number,
): string {
  const category = new Intl.PluralRules(language).select(count);
  const template = forms[category] ?? forms.other ?? forms.one;
  if (template === undefined) return formatNumber(language, count);
  return interpolate(template, { count });
}

/** Localised number, e.g. "1.234" in German and "1,234" in English. */
export function formatNumber(language: Language, value: number): string {
  return new Intl.NumberFormat(language).format(value);
}

export function formatCurrency(language: Language, value: number, currencyCode?: string | null): string {
  if (!currencyCode) return formatNumber(language, value);
  try {
    return new Intl.NumberFormat(language, { style: "currency", currency: currencyCode }).format(value);
  } catch {
    return formatNumber(language, value);
  }
}

/** Absolute date and time, e.g. "1 Feb 2026, 14:30". */
export function formatDateTime(language: Language, value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** "3 days ago", "just now", in the chosen language. */
export function formatRelativeTime(language: Language, value: Date | string | number, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(Math.round(seconds), "second");
}

/** Joins a list the way the chosen language expects, e.g. "a, b and c". */
export function formatList(language: Language, items: readonly string[]): string {
  return new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(items);
}

/** The whole catalog for a language, used by the locale completeness test. */
export function catalogFor(language: Language): Messages {
  return CATALOGS[language];
}
