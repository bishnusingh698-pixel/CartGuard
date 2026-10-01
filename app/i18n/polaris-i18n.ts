/**
 * Polaris' own translations, importable from both server and client code.
 *
 * Kept out of `context.tsx` because the loaders need the same table, and a
 * loader must not pull JSX or React into the server bundle. The provider in
 * `context.tsx` reads from here too, so the two can never drift.
 */

import polarisEn from "@shopify/polaris/locales/en.json";
import polarisDe from "@shopify/polaris/locales/de.json";
import polarisFr from "@shopify/polaris/locales/fr.json";
import polarisEs from "@shopify/polaris/locales/es.json";
import polarisPtBR from "@shopify/polaris/locales/pt-BR.json";
import polarisZhCN from "@shopify/polaris/locales/zh-CN.json";
import polarisJa from "@shopify/polaris/locales/ja.json";
import polarisIt from "@shopify/polaris/locales/it.json";
import polarisNl from "@shopify/polaris/locales/nl.json";
import polarisSv from "@shopify/polaris/locales/sv.json";

import { DEFAULT_LANGUAGE, type Language } from "./locales";

/**
 * Polaris catalogs are nested (`Polaris.Button.loading`), so the type is taken
 * from the English import rather than hand-written: a hand-written
 * `Record<string, string>` would reject every one of them at compile time.
 */
export type PolarisMessages = typeof polarisEn;

/**
 * Polaris ships a catalog per admin language, so its component strings (a
 * button's "Cancel", pagination labels) follow the merchant's choice too.
 * Using the same code as our own catalogs means one language choice drives
 * both.
 */
export const POLARIS_I18N: Record<Language, PolarisMessages> = {
  en: polarisEn,
  de: polarisDe,
  fr: polarisFr,
  es: polarisEs,
  "pt-BR": polarisPtBR,
  "zh-CN": polarisZhCN,
  ja: polarisJa,
  it: polarisIt,
  nl: polarisNl,
  sv: polarisSv,
};

export function polarisMessages(language: Language): PolarisMessages {
  return POLARIS_I18N[language] ?? POLARIS_I18N[DEFAULT_LANGUAGE];
}
