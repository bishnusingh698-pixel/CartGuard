/**
 * Section metadata and plain-language summaries of a rule configuration.
 * Pure, so the editor, future dashboard pages and the server share one
 * vocabulary.
 */

import {
  PRODUCT_GID_PREFIX,
  type FeatureFlag,
  type QuantityLimit,
  type RuleConfig,
} from "../../extensions/cartguard-validator/src/rules";
import { countryName } from "./regions";
import type { MessageKey } from "../i18n/catalog";

export const RULE_SECTIONS = ["geo", "address", "quantity", "vip"] as const;
export type RuleSection = (typeof RULE_SECTIONS)[number];

export type SectionMeta = { anchor: string; flag: FeatureFlag };

/**
 * The catalog key for each section heading. Several pages render a section title
 * (overview, order check, fix list), so the mapping lives here rather than being
 * re-declared per route.
 */
export const SECTION_TITLE_KEY = {
  geo: "section.geo.title",
  address: "section.address.title",
  quantity: "section.quantity.title",
  vip: "section.vip.title",
} as const satisfies Record<RuleSection, MessageKey>;

/** Description keys follow the same pattern, so both can be derived. */
export const SECTION_DESCRIPTION_KEY = Object.fromEntries(
  RULE_SECTIONS.map((section) => [section, `section.${section}.description`]),
) as Record<RuleSection, MessageKey>;

/**
 * Only the non-translatable parts: the anchor used for in-page links and the
 * feature flag the section toggles. Titles and descriptions are catalog keys
 * (SECTION_TITLE_KEY / SECTION_DESCRIPTION_KEY) so every page renders them
 * through `t` rather than reading English literals from here.
 */
export const SECTION_META: Record<RuleSection, SectionMeta> = {
  geo: { anchor: "countries-and-regions", flag: "enable_geo" },
  address: { anchor: "addresses", flag: "enable_po_box" },
  quantity: { anchor: "order-quantities", flag: "enable_quantity" },
  vip: { anchor: "trusted-customers", flag: "enable_vip" },
};

/**
 * A summary detail as structured data rather than a finished sentence, so the
 * component that renders it can translate it. `count` drives plural selection.
 */
export type SummaryDetail = { key: MessageKey; count?: number; values?: string[]; more?: number };

export type SectionSummary = { enabled: boolean; empty: boolean; details: SummaryDetail[] };

const numberFormat = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** 3 of 8 -> "38%"; 1 of 300 -> "less than 1%". */
export function formatShare(part: number, total: number, lessThanOnePercent = "less than 1%"): string {
  if (total <= 0) return "0%";
  const share = (part / total) * 100;
  if (part > 0 && share < 1) return lessThanOnePercent;
  return `${Math.round(share)}%`;
}

/**
 * Formats a list of names using the locale's own list rules. The caller
 * translates the "and N more" tail, so only the names come from here.
 */
function joinNames(items: string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
}

/** A value interpolated into a message: literal text, or a nested message. */
export type MessageValue = string | number | ValidationMessage | ValidationMessage[];

/**
 * A message as a catalog key plus its interpolations. Keeping these as keys
 * rather than finished English means the reader's language chooses the wording,
 * and labels embedded in them can be translated too.
 */
export type ValidationMessage = { key: string; values?: Record<string, MessageValue> };

/** The display name of a limit's target as a catalog key plus its interpolations. */
export function limitTargetLabel(key: string): { key: string; values?: Record<string, string> } {
  const trimmed = key.trim();
  if (trimmed === "*" || trimmed.toLowerCase() === "all") return { key: "label.target.all" };
  if (trimmed.startsWith(PRODUCT_GID_PREFIX)) return { key: "label.target.productId", values: { id: trimmed.slice(PRODUCT_GID_PREFIX.length) } };
  if (/^\d+$/.test(trimmed)) return { key: "label.target.productId", values: { id: trimmed } };
  return { key: "label.target.tag", values: { tag: trimmed } };
}

const BUILT_IN_LABELS: Record<string, MessageKey> = {
  po_box: "summary.address.poBox",
  military: "summary.address.military",
};

/** Catalog key for a quantity limit's target, for use in a summary line. */
function limitTargetMessage(key: string): MessageKey {
  const trimmed = key.trim();
  if (trimmed === "*" || trimmed.toLowerCase() === "all") return "summary.target.all";
  if (trimmed.startsWith(PRODUCT_GID_PREFIX)) return "summary.target.productId";
  if (/^\d+$/.test(trimmed)) return "summary.target.productId";
  return "summary.target.tag";
}

const wholeUnits = (value: number | undefined): number | null =>
  value === undefined || !Number.isFinite(value) ? null : value;

/** "up to 10", "from 3", "1 to 10", plus the order amount when one is set. */
export function limitRange(limit: QuantityLimit): string | null {
  const parts: string[] = [];
  const min = wholeUnits(limit.min);
  const max = wholeUnits(limit.max);
  if (min !== null && max !== null) parts.push(`${formatNumber(min)} to ${formatNumber(max)} units`);
  else if (max !== null) parts.push(`up to ${formatNumber(max)} units`);
  else if (min !== null) parts.push(`from ${formatNumber(min)} units`);
  if (limit.minAmount !== undefined && Number.isFinite(limit.minAmount)) {
    parts.push(`orders from ${formatNumber(limit.minAmount)}`);
  }
  if (limit.maxAmount !== undefined && Number.isFinite(limit.maxAmount)) {
    parts.push(`orders up to ${formatNumber(limit.maxAmount)}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export function summarizeSections(config: RuleConfig, locale = "en"): Record<RuleSection, SectionSummary> {
  const { settings, geoBlocklist: geo, regexRules, quantityLimits, vipAllowlist } = config;

  const geoDetails: SummaryDetail[] = [];
  if (geo.countries.length > 0) {
    const names = geo.countries.map((code) => countryName(code, locale));
    geoDetails.push({
      key: "summary.geo.countries",
      values: [joinNames(names.slice(0, 3), locale)],
      more: names.length > 3 ? names.length - 3 : undefined,
    });
  }
  if (geo.states.length > 0) geoDetails.push({ key: "summary.geo.states", count: geo.states.length });
  if (geo.cities.length > 0) geoDetails.push({ key: "summary.geo.cities", count: geo.cities.length });
  if (geo.zips.length > 0) geoDetails.push({ key: "summary.geo.zips", count: geo.zips.length });

  const builtIns = new Set<string>();
  let keywords = 0;
  let specific = 0;
  for (const rule of regexRules) {
    if (rule.preset && Object.hasOwn(BUILT_IN_LABELS, rule.preset)) builtIns.add(rule.preset);
    else if (rule.preset === "keywords") keywords += rule.keywords?.length || 1;
    else specific += 1;
  }
  const addressDetails: SummaryDetail[] = Object.keys(BUILT_IN_LABELS)
    .filter((preset) => builtIns.has(preset))
    .map((preset) => ({ key: BUILT_IN_LABELS[preset] }) as SummaryDetail);
  if (keywords > 0) addressDetails.push({ key: "summary.address.keywords", count: keywords });
  if (specific > 0) addressDetails.push({ key: "summary.address.specific", count: specific });

  // Skip limits still being typed (no valid bound yet).
  const limits = Object.entries(quantityLimits).filter(([, limit]) => limitRange(limit) !== null);
  const quantityDetails: SummaryDetail[] = limits.slice(0, 2).map(([key]) => ({ key: limitTargetMessage(key) }));
  if (limits.length > 2) quantityDetails.push({ key: "summary.more", count: limits.length - 2 });

  const emails = vipAllowlist.filter((entry) => entry.includes("@")).length;
  const addresses = vipAllowlist.length - emails;
  const vipDetails: SummaryDetail[] = [];
  if (emails > 0) vipDetails.push({ key: "summary.vip.emails", count: emails });
  if (addresses > 0) vipDetails.push({ key: "summary.vip.addresses", count: addresses });

  const summary = (enabled: boolean, details: SummaryDetail[]): SectionSummary => ({
    enabled,
    empty: details.length === 0,
    details,
  });
  return {
    geo: summary(settings.enable_geo, geoDetails),
    address: summary(settings.enable_po_box, addressDetails),
    quantity: summary(settings.enable_quantity, quantityDetails),
    vip: summary(settings.enable_vip, vipDetails),
  };
}
