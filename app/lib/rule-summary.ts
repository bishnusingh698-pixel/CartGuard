/**
 * Section metadata and plain-language summaries of a rule configuration.
 * Pure, so the editor, future dashboard pages and the server share one
 * vocabulary.
 */

import { PRODUCT_GID_PREFIX, type FeatureFlag, type RuleConfig } from "../../extensions/cartguard-validator/src/rules";
import { countryName } from "./regions";

export const RULE_SECTIONS = ["geo", "address", "quantity", "vip"] as const;
export type RuleSection = (typeof RULE_SECTIONS)[number];

export type SectionMeta = { title: string; description: string; anchor: string; flag: FeatureFlag };

export const SECTION_META: Record<RuleSection, SectionMeta> = {
  geo: {
    title: "Countries and regions",
    description: "Block orders shipping to countries, states, cities or postal codes you don't deliver to.",
    anchor: "countries-and-regions",
    flag: "enable_geo",
  },
  address: {
    title: "Addresses",
    description: "Block PO Boxes, reshipping services and specific addresses that are often used for fraud.",
    anchor: "addresses",
    flag: "enable_po_box",
  },
  quantity: {
    title: "Order quantities",
    description: "Limit how many units of a product one order can include, to stop resellers and bots.",
    anchor: "order-quantities",
    flag: "enable_quantity",
  },
  vip: {
    title: "Trusted customers",
    description: "Let customers you trust skip these rules. Blocked countries still apply to them.",
    anchor: "trusted-customers",
    flag: "enable_vip",
  },
};

export type SectionSummary = { enabled: boolean; empty: boolean; details: string[] };

const numberFormat = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function pluralize(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** 3 of 8 -> "38%"; 1 of 300 -> "less than 1%". */
export function formatShare(part: number, total: number): string {
  if (total <= 0) return "0%";
  const share = (part / total) * 100;
  if (part > 0 && share < 1) return "less than 1%";
  return `${Math.round(share)}%`;
}

function preview(items: string[], max = 3): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${formatNumber(items.length - max)} more`;
}

/** Merchant-facing name for a quantity limit key. */
export function limitTargetLabel(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "*" || trimmed.toLowerCase() === "all") return "Every product";
  if (trimmed.startsWith(PRODUCT_GID_PREFIX)) return `Product ${trimmed.slice(PRODUCT_GID_PREFIX.length)}`;
  if (/^\d+$/.test(trimmed)) return `Product ${trimmed}`;
  return `Products tagged "${trimmed}"`;
}

const BUILT_IN_LABELS: Record<string, string> = {
  po_box: "PO Boxes",
  freight: "Freight forwarders",
  military: "Military addresses",
};

export function summarizeSections(config: RuleConfig): Record<RuleSection, SectionSummary> {
  const { settings, geoBlocklist: geo, regexRules, quantityLimits, vipAllowlist } = config;

  const geoDetails: string[] = [];
  if (geo.countries.length > 0) geoDetails.push(preview(geo.countries.map(countryName)));
  if (geo.states.length > 0) geoDetails.push(pluralize(geo.states.length, "state or province", "states or provinces"));
  if (geo.cities.length > 0) geoDetails.push(pluralize(geo.cities.length, "city", "cities"));
  if (geo.zips.length > 0) geoDetails.push(pluralize(geo.zips.length, "postal code"));

  const builtIns = new Set<string>();
  let keywords = 0;
  let specific = 0;
  for (const rule of regexRules) {
    if (rule.preset && Object.hasOwn(BUILT_IN_LABELS, rule.preset)) builtIns.add(rule.preset);
    else if (rule.preset === "keywords") keywords += rule.keywords?.length || 1;
    else specific += 1;
  }
  const addressDetails = Object.keys(BUILT_IN_LABELS)
    .filter((preset) => builtIns.has(preset))
    .map((preset) => BUILT_IN_LABELS[preset]);
  if (keywords > 0) addressDetails.push(pluralize(keywords, "blocked word"));
  if (specific > 0) addressDetails.push(pluralize(specific, "specific address", "specific addresses"));

  // Skip limits still being typed (no valid number yet).
  const limits = Object.entries(quantityLimits).filter(([, limit]) => Number.isFinite(limit.max) && limit.max > 0);
  const quantityDetails = limits
    .slice(0, 2)
    .map(([key, limit]) => `${limitTargetLabel(key)}: up to ${formatNumber(limit.max)}`);
  if (limits.length > 2) quantityDetails.push(`${formatNumber(limits.length - 2)} more`);

  const emails = vipAllowlist.filter((entry) => entry.includes("@")).length;
  const addresses = vipAllowlist.length - emails;
  const vipDetails: string[] = [];
  if (emails > 0) vipDetails.push(pluralize(emails, "customer email"));
  if (addresses > 0) vipDetails.push(pluralize(addresses, "street address", "street addresses"));

  const summary = (enabled: boolean, details: string[]): SectionSummary => ({
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
