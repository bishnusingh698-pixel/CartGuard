/**
 * React access to the active language.
 *
 * The language is resolved on the server per shop and passed into the root
 * loader, so the first render already has the right strings and `document.lang`
 * is correct before hydration. Changing the language in the UI re-renders
 * through this context instead of reloading the page.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { DEFAULT_LANGUAGE, type Language } from "./locales";
import { type PolarisMessages, polarisMessages } from "./polaris-i18n";
import {
  type MessageKey,
  type TranslateValues,
  formatCurrency,
  formatDateTime,
  formatList,
  formatNumber,
  formatRelativeTime,
  plural,
  translate,
} from "./catalog";

export type I18nContextValue = {
  language: Language;
  /** Translates a key, falling back to English. */
  t: (key: MessageKey, values?: TranslateValues) => string;
  /** Locale-specific plural rules, e.g. Japanese has only `other`. */
  plural: (forms: Record<Intl.LDMLPluralRule, string>, count: number) => string;
  number: (value: number) => string;
  currency: (value: number, currencyCode?: string | null) => string;
  dateTime: (value: Date | string | number) => string;
  relativeTime: (value: Date | string | number) => string;
  list: (items: readonly string[]) => string;
  /** Polaris' own translations for the active language. */
  polarisI18n: PolarisMessages;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      t: (key, values) => translate(language, key, values),
      plural: (forms, count) => plural(language, forms, count),
      number: (input) => formatNumber(language, input),
      currency: (input, currencyCode) => formatCurrency(language, input, currencyCode),
      dateTime: (input) => formatDateTime(language, input),
      relativeTime: (input) => formatRelativeTime(language, input),
      list: (items) => formatList(language, items),
      polarisI18n: polarisMessages(language),
    }),
    [language],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Active language and helpers. Falls back to English rather than throwing so a
 * component rendered outside the provider (an error boundary, a test) still
 * shows readable copy instead of raw keys.
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  return context ?? FALLBACK;
}

const FALLBACK: I18nContextValue = {
  language: DEFAULT_LANGUAGE,
  t: (key, values) => translate(DEFAULT_LANGUAGE, key, values),
  plural: (forms, count) => plural(DEFAULT_LANGUAGE, forms, count),
  number: (value) => formatNumber(DEFAULT_LANGUAGE, value),
  currency: (value, currencyCode) => formatCurrency(DEFAULT_LANGUAGE, value, currencyCode),
  dateTime: (value) => formatDateTime(DEFAULT_LANGUAGE, value),
  relativeTime: (value) => formatRelativeTime(DEFAULT_LANGUAGE, value),
  list: (items) => formatList(DEFAULT_LANGUAGE, items),
  polarisI18n: polarisMessages(DEFAULT_LANGUAGE),
};