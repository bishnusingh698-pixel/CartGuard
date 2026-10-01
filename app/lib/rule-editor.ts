/**
 * Form state for the block rules editor and its conversion to and from the
 * stored rule configuration. Pure (no React, no I/O) so the browser, the
 * server and the tests all use the same logic.
 *
 * Every rule a merchant can store has a form equivalent here: built-in
 * address checks, blocked words, specific addresses (plain text or an
 * advanced pattern, optionally limited to a country or city, with a custom
 * message), quantity limits by tag, product or every product with custom
 * messages, blocked countries, states, cities and postal codes (optionally
 * limited to one country) and trusted customers.
 */

import {
  ADDRESS_PRESETS,
  DEFAULT_ADDRESS_MESSAGE,
  MAX_ORDER_AMOUNT,
  MAX_PATTERN_LENGTH,
  MAX_UNITS,
  MIN_VIP_ADDRESS_LENGTH,
  PRODUCT_GID_PREFIX,
  compileRegex,
  isRiskyPattern,
  splitCountryScope,
  type CartGuardSettings,
  type QuantityLimit,
  type RegexRule,
  type RuleConfig,
} from "../../extensions/cartguard-validator/src/rules";
import { findCountry, isCountryCode, isValidStateEntry } from "./regions";
import { formatNumber, type RuleSection } from "./rule-summary";

export const MESSAGE_MAX_LENGTH = 250;
export { MAX_ORDER_AMOUNT, MAX_UNITS };

export const KEYWORD_MESSAGE = "Your delivery address contains words we can't ship to. Please use a different address.";
/** Message older builds saved with specific-address rules. */
const LEGACY_STREET_MESSAGE = "We can't deliver to this address. Please use a different delivery address.";

export const BUILT_IN_CHECKS = ["po_box", "military"] as const;
export type BuiltInCheck = (typeof BUILT_IN_CHECKS)[number];

function isBuiltInCheck(preset: string | undefined): preset is BuiltInCheck {
  return (BUILT_IN_CHECKS as readonly string[]).includes(preset ?? "");
}

export type AddressMatch = "contains" | "pattern";

export type AddressRuleRow = {
  id: string;
  match: AddressMatch;
  text: string;
  /** Country code, or "" for every country. */
  country: string;
  city: string;
  message: string;
};

export type LimitTarget = "tag" | "product" | "all";

/**
 * One row of the "Order quantities" editor. Unit bounds apply to the matched
 * product(s); the amount bounds apply to the whole order and are only offered
 * on the "Every product" row, so one row always reads as one rule.
 */
export type LimitRow = {
  id: string;
  target: LimitTarget;
  value: string;
  min: string;
  max: string;
  /** Order total bounds, in the shop currency, only used on "Every product" rows. */
  minAmount: string;
  maxAmount: string;
  message: string;
};

export type EditorState = {
  settings: CartGuardSettings;
  countries: string[];
  states: string[];
  cities: string[];
  zips: string[];
  checks: Record<BuiltInCheck, boolean>;
  keywords: string[];
  addressRules: AddressRuleRow[];
  limits: LimitRow[];
  vipEmails: string[];
  vipAddresses: string[];
  /** Customer messages saved with built-in checks, kept so saving never resets them. */
  presetMessages: Partial<Record<BuiltInCheck | "keywords", string>>;
};

let rowSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++rowSeq}`;

export function newAddressRule(): AddressRuleRow {
  return { id: nextId("address"), match: "contains", text: "", country: "", city: "", message: "" };
}

export function newLimit(): LimitRow {
  return { id: nextId("limit"), target: "tag", value: "", min: "", max: "", minAmount: "", maxAmount: "", message: "" };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The plain text a pattern matches literally, or null for real patterns. */
export function literalText(pattern: string): string | null {
  const text = pattern.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
  return escapeRegex(text) === pattern ? text : null;
}

/* ── Stored config -> form ───────────────────────────────────────────────── */

function ruleToRow(rule: RegexRule): AddressRuleRow {
  const street = rule.preset === "street" && rule.street && escapeRegex(rule.street) === rule.pattern ? rule.street : null;
  const literal = street ?? literalText(rule.pattern);
  const message =
    rule.message && rule.message !== DEFAULT_ADDRESS_MESSAGE && rule.message !== LEGACY_STREET_MESSAGE ? rule.message : "";
  const country = rule.country ? findCountry(rule.country) ?? rule.country.toUpperCase() : "";
  return {
    id: nextId("address"),
    match: literal === null ? "pattern" : "contains",
    text: literal ?? rule.pattern,
    country,
    city: rule.city ?? "",
    message,
  };
}

function limitToRow(key: string, limit: QuantityLimit): LimitRow {
  const base = {
    id: nextId("limit"),
    min: limit.min === undefined ? "" : String(limit.min),
    max: limit.max === undefined ? "" : String(limit.max),
    minAmount: limit.minAmount === undefined ? "" : String(limit.minAmount),
    maxAmount: limit.maxAmount === undefined ? "" : String(limit.maxAmount),
    message: limit.message ?? "",
  };
  if (key === "*" || key.toLowerCase() === "all") return { ...base, target: "all", value: "" };
  if (key.startsWith(PRODUCT_GID_PREFIX)) return { ...base, target: "product", value: key.slice(PRODUCT_GID_PREFIX.length) };
  if (/^\d+$/.test(key)) return { ...base, target: "product", value: key };
  return { ...base, target: "tag", value: key };
}

export function editorFromConfig(config: RuleConfig): EditorState {
  const claimed = new Set<RegexRule>();
  const claim = (preset: string, accept: (rule: RegexRule) => boolean = () => true) => {
    const rule = config.regexRules.find((candidate) => candidate.preset === preset && !claimed.has(candidate) && accept(candidate));
    if (rule) claimed.add(rule);
    return rule;
  };

  const checks = {} as Record<BuiltInCheck, boolean>;
  const presetMessages: EditorState["presetMessages"] = {};
  for (const check of BUILT_IN_CHECKS) {
    const rule = claim(check);
    checks[check] = Boolean(rule);
    if (rule?.message && rule.message !== ADDRESS_PRESETS[check].message) presetMessages[check] = rule.message;
  }
  const keywordRule = claim("keywords", (rule) => (rule.keywords?.length ?? 0) > 0);
  if (keywordRule?.message && keywordRule.message !== KEYWORD_MESSAGE) presetMessages.keywords = keywordRule.message;

  // Everything not owned by a built-in control becomes an editable specific
  // address, so no stored rule is ever dropped. Exact copies of a built-in
  // check add nothing and are skipped.
  const addressRules = config.regexRules
    .filter((rule) => !claimed.has(rule))
    .filter((rule) => !(isBuiltInCheck(rule.preset) && rule.pattern === ADDRESS_PRESETS[rule.preset].pattern))
    .map(ruleToRow);

  return {
    settings: { ...config.settings },
    countries: [...config.geoBlocklist.countries],
    states: [...config.geoBlocklist.states],
    cities: [...config.geoBlocklist.cities],
    zips: [...config.geoBlocklist.zips],
    checks,
    keywords: [...(keywordRule?.keywords ?? [])],
    addressRules,
    limits: Object.entries(config.quantityLimits).map(([key, limit]) => limitToRow(key, limit)),
    vipEmails: config.vipAllowlist.filter((entry) => entry.includes("@")),
    vipAddresses: config.vipAllowlist.filter((entry) => !entry.includes("@")),
    presetMessages,
  };
}

/* ── Form -> stored config ───────────────────────────────────────────────── */

function rowToRule(row: AddressRuleRow): RegexRule | null {
  const text = row.text.trim();
  if (!text) return null;
  const scope: { country?: string; city?: string; message?: string } = {};
  if (row.country) scope.country = row.country;
  const city = row.city.trim();
  if (city) scope.city = city;
  const message = row.message.trim();
  if (message) scope.message = message;
  if (row.match === "contains") return { preset: "street", street: text, pattern: escapeRegex(text), ...scope };
  return { pattern: text, ...scope };
}

function limitKey(row: LimitRow): string | null {
  if (row.target === "all") return "all";
  const value = row.value.trim();
  if (!value) return null;
  return row.target === "product" ? value.replace(PRODUCT_GID_PREFIX, "") : value;
}

export function configFromEditor(state: EditorState): RuleConfig {
  const regexRules: RegexRule[] = [];
  for (const check of BUILT_IN_CHECKS) {
    if (!state.checks[check]) continue;
    const preset = ADDRESS_PRESETS[check];
    regexRules.push({
      preset: check,
      pattern: preset.pattern,
      message: state.presetMessages[check] ?? preset.message,
      ...(preset.country ? { country: preset.country } : {}),
    });
  }
  if (state.keywords.length > 0) {
    regexRules.push({
      preset: "keywords",
      keywords: [...state.keywords],
      pattern: state.keywords.map(escapeRegex).join("|"),
      message: state.presetMessages.keywords ?? KEYWORD_MESSAGE,
    });
  }
  for (const row of state.addressRules) {
    const rule = rowToRule(row);
    if (rule) regexRules.push(rule);
  }

  const quantityLimits: Record<string, QuantityLimit> = {};
  for (const row of state.limits) {
    const key = limitKey(row);
    if (!key) continue; // an untouched row: nothing to limit yet
    const limit: QuantityLimit = {};
    const min = readUnits(row.min);
    const max = readUnits(row.max);
    // Amount bounds are order-wide, so they are only read from the
    // "Every product" row. A value still being typed is left out here and
    // reported by validateEditor instead of being half-saved.
    const minAmount = row.target === "all" ? readAmount(row.minAmount) : undefined;
    const maxAmount = row.target === "all" ? readAmount(row.maxAmount) : undefined;
    if (min === null || max === null || minAmount === null || maxAmount === null) continue;
    if (min !== undefined) limit.min = min;
    if (max !== undefined) limit.max = max;
    if (minAmount !== undefined) limit.minAmount = minAmount;
    if (maxAmount !== undefined) limit.maxAmount = maxAmount;
    const message = row.message.trim();
    quantityLimits[key] = message ? { ...limit, message } : limit;
  }

  return {
    settings: { ...state.settings },
    regexRules,
    quantityLimits,
    geoBlocklist: {
      countries: [...state.countries],
      zips: [...state.zips],
      cities: [...state.cities],
      states: [...state.states],
    },
    vipAllowlist: [...state.vipEmails, ...state.vipAddresses],
  };
}

/**
 * Units typed in a limit row: a whole number of at least 1, or undefined when
 * the field is blank. Null means the value can't be saved. Zero is rejected on
 * purpose: a bound of 0 would stop every order that contains the product.
 */
function readUnits(raw: string): number | undefined | null {
  const value = raw.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_UNITS) return null;
  return parsed;
}

/** Order total typed in a limit row. Null means the value can't be saved. */
function readAmount(raw: string): number | undefined | null {
  const value = raw.trim().replace(/[\s,]/g, "");
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_ORDER_AMOUNT) return null;
  return Math.round(parsed * 100) / 100;
}

/* ── Field parsers ───────────────────────────────────────────────────────── */

export type ParseResult = { value: string } | { error: string };

const quoted = (raw: string) => `"${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}"`;

export function parseCountryEntry(raw: string): ParseResult {
  const code = findCountry(raw);
  return code
    ? { value: code }
    : { error: `We don't recognise ${quoted(raw)} as a country. Pick it from the list or use its 2-letter code, like CR.` };
}

export function parseRegionCode(raw: string): ParseResult {
  const value = raw.trim().toUpperCase().replace(/\s+/g, " ");
  return value.length <= 6 && /^[A-Z0-9]+(?: [A-Z0-9]+)?$/.test(value)
    ? { value }
    : { error: "Region codes are up to 6 letters or numbers, like 13, MH or TAMPS." };
}

export function parseCity(raw: string): ParseResult {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < 2 || value.length > 85 || !/\p{L}/u.test(value) || /[<>@{}[\]|\\=_]/.test(value)) {
    return { error: `${quoted(raw)} doesn't look like a city name.` };
  }
  return { value };
}

export function parseZip(raw: string): ParseResult {
  const value = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (!/^[A-Z0-9][A-Z0-9 -]{0,11}$/.test(value) || value.replace(/[^A-Z0-9]/g, "").length < 2) {
    return { error: `${quoted(raw)} doesn't look like a postal code. Use letters, numbers, spaces or dashes.` };
  }
  return { value };
}

export function parseKeyword(raw: string): ParseResult {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < 2) return { error: "Use at least 2 characters so normal addresses aren't blocked by accident." };
  if (value.length > 100) return { error: "Keep blocked words under 100 characters." };
  if (!/[\p{L}\p{N}]/u.test(value)) return { error: "Include at least one letter or number." };
  return { value };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseVipEmail(raw: string): ParseResult {
  const value = raw.trim();
  return EMAIL.test(value) && value.length <= 254 ? { value } : { error: `${quoted(raw)} isn't a valid email address.` };
}

export function parseVipAddress(raw: string): ParseResult {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.includes("@")) return { error: "That looks like an email. Add it under trusted customer emails instead." };
  if (value.length < MIN_VIP_ADDRESS_LENGTH || !/\p{L}/u.test(value)) {
    return { error: 'Enter the full street address as customers type it, like "123 Executive Blvd".' };
  }
  if (value.length > 255) return { error: "Keep the address under 255 characters." };
  return { value };
}

/** Wraps a parser so accepted values are limited to one country ("US:Austin"). */
export function withCountryScope(parse: (raw: string) => ParseResult, country: string): (raw: string) => ParseResult {
  return (raw) => {
    const result = parse(raw);
    if ("error" in result || !country) return result;
    return { value: `${country}:${result.value}` };
  };
}

function scopedEntryValid(entry: string, parse: (raw: string) => ParseResult): boolean {
  const { country, value } = splitCountryScope(entry, false);
  if (country && !isCountryCode(country)) return false;
  return !("error" in parse(value));
}

export function patternProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return `Keep the pattern under ${MAX_PATTERN_LENGTH} characters.`;
  if (!compileRegex(pattern)) return "This pattern isn't valid. Check for unmatched brackets.";
  if (isRiskyPattern(pattern)) return "This pattern could slow down checkout. Try a simpler one.";
  return null;
}

/* ── Validation ──────────────────────────────────────────────────────────── */

export const LIST_FIELD_IDS = {
  countries: "geo.countries",
  states: "geo.states",
  cities: "geo.cities",
  zips: "geo.zips",
  keywords: "address.keywords",
  vipEmails: "vip.emails",
  vipAddresses: "vip.addresses",
} as const;

export type EditorErrors = {
  /** Keyed by row id or LIST_FIELD_IDS entry, then by field name. */
  fields: Record<string, Record<string, string>>;
  bySection: Record<RuleSection, number>;
  total: number;
};

export function validateEditor(state: EditorState): EditorErrors {
  const errors: EditorErrors = { fields: {}, bySection: { geo: 0, address: 0, quantity: 0, vip: 0 }, total: 0 };
  const add = (section: RuleSection, id: string, field: string, message: string) => {
    const bucket = (errors.fields[id] ??= {});
    if (bucket[field]) return;
    bucket[field] = message;
    errors.bySection[section] += 1;
    errors.total += 1;
  };
  const accepts = (parse: (raw: string) => ParseResult) => (value: string) => !("error" in parse(value));
  const checkList = (section: RuleSection, id: string, values: string[], valid: (value: string) => boolean) => {
    const invalid = values.filter((value) => !valid(value));
    if (invalid.length === 0) return;
    const shown = invalid.slice(0, 5).join(", ");
    add(section, id, "list", `Remove ${invalid.length === 1 ? "this entry, it isn't" : "these entries, they aren't"} valid: ${shown}${invalid.length > 5 ? "…" : ""}`);
  };

  // Entries saved by older versions may not pass today's checks.
  checkList("geo", LIST_FIELD_IDS.countries, state.countries, accepts(parseCountryEntry));
  checkList("geo", LIST_FIELD_IDS.states, state.states, isValidStateEntry);
  checkList("geo", LIST_FIELD_IDS.cities, state.cities, (value) => scopedEntryValid(value, parseCity));
  checkList("geo", LIST_FIELD_IDS.zips, state.zips, (value) => scopedEntryValid(value, parseZip));
  checkList("address", LIST_FIELD_IDS.keywords, state.keywords, accepts(parseKeyword));
  checkList("vip", LIST_FIELD_IDS.vipEmails, state.vipEmails, accepts(parseVipEmail));
  checkList("vip", LIST_FIELD_IDS.vipAddresses, state.vipAddresses, accepts(parseVipAddress));

  for (const row of state.addressRules) {
    const text = row.text.trim();
    if (!text) {
      if (row.city.trim() || row.message.trim() || row.country) {
        add("address", row.id, "text", row.match === "contains" ? "Enter the address text to block, or remove this address." : "Enter a pattern, or remove this address.");
      }
    } else if (row.match === "contains") {
      if (text.length < 2) add("address", row.id, "text", "Use at least 2 characters so normal addresses aren't blocked by accident.");
      else if (!/[\p{L}\p{N}]/u.test(text)) add("address", row.id, "text", "Include at least one letter or number.");
    } else {
      const problem = patternProblem(text);
      if (problem) add("address", row.id, "text", problem);
    }
    if (row.country && !isCountryCode(row.country)) add("address", row.id, "country", "Choose a country from the list.");
    if (row.city.trim() && "error" in parseCity(row.city)) add("address", row.id, "city", "Enter a real city name, or leave this blank.");
  }

  const seen = new Set<string>();
  for (const row of state.limits) {
    const value = row.value.trim();
    const amountFields = row.target === "all" && (row.minAmount.trim() || row.maxAmount.trim());
    if (row.target !== "all" && !value) {
      if (row.min.trim() || row.max.trim() || row.message.trim() || amountFields) {
        add("quantity", row.id, "value", row.target === "tag" ? "Enter a product tag, or remove this limit." : "Enter a product ID, or remove this limit.");
      }
      continue;
    }
    if (row.target === "product" && !/^\d+$/.test(value.replace(PRODUCT_GID_PREFIX, ""))) {
      add("quantity", row.id, "value", "Product IDs are numbers only. Copy it from the end of the product's page address in Shopify.");
    }
    if (row.target === "tag" && value.length > 255) add("quantity", row.id, "value", "Tags can't be longer than 255 characters.");
    const key = limitKey(row)?.toLowerCase();
    if (key) {
      if (seen.has(key)) add("quantity", row.id, "value", "You already have a limit for this. Change or remove one of them.");
      seen.add(key);
    }

    const min = readUnits(row.min);
    const max = readUnits(row.max);
    if (min === null) add("quantity", row.id, "min", `Enter a whole number from 1 to ${formatNumber(MAX_UNITS)}, or leave it blank.`);
    if (max === null) add("quantity", row.id, "max", `Enter a whole number from 1 to ${formatNumber(MAX_UNITS)}, or leave it blank.`);
    if (min !== null && max !== null && min !== undefined && max !== undefined && min > max) {
      add("quantity", row.id, "min", "The minimum can't be more than the maximum.");
    }
    if (min === undefined && max === undefined && !amountFields) {
      add("quantity", row.id, "max", "Set a minimum, a maximum or an order amount. Remove this limit if you don't need it.");
    }

    if (row.target !== "all") {
      // Amount bounds are order-wide, so they belong on the "Every product" row.
      for (const field of ["minAmount", "maxAmount"] as const) {
        if (row[field].trim()) add("quantity", row.id, field, 'Order amounts only apply to the "Every product" limit.');
      }
      continue;
    }
    const minAmount = readAmount(row.minAmount);
    const maxAmount = readAmount(row.maxAmount);
    if (minAmount === null) add("quantity", row.id, "minAmount", `Enter an amount up to ${formatNumber(MAX_ORDER_AMOUNT)}, or leave it blank.`);
    if (maxAmount === null) add("quantity", row.id, "maxAmount", `Enter an amount up to ${formatNumber(MAX_ORDER_AMOUNT)}, or leave it blank.`);
    if (minAmount !== null && maxAmount !== null && minAmount !== undefined && maxAmount !== undefined && minAmount > maxAmount) {
      add("quantity", row.id, "minAmount", "The smallest order can't be more than the largest one.");
    }
  }

  return errors;
}
