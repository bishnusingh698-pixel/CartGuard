/**
 * CartGuard server helpers for the admin app.
 *
 * - Configuration lives in app-owned shop metafields ($app:cartguard, type
 *   json). Other apps and staff can't edit them. Values saved by older builds
 *   under the public "cartguard" namespace are read as a fallback and removed
 *   on the next save.
 * - Strict validation of the structured rules the editor submits (save-time
 *   quality gate; checkout stays fail-open).
 * - Impact Checker: simulates the rules on recent orders using the same rule
 *   engine as the checkout Function (extensions/cartguard-validator/src/rules.ts).
 */

import {
  type AdminApi,
  type GraphqlCost,
  adminGraphql,
  errorMessage,
  friendlyErrorMessage,
  setMetafields,
} from "./admin-api.server";
import { countryName, findCountry, isValidStateEntry } from "./regions";
import { type RuleSection, formatNumber, limitTargetLabel } from "./rule-summary";
import { ensureValidationEnabled } from "./validation.server";
import {
  ADDRESS_PRESETS,
  FEATURE_FLAGS,
  type AddressPreset,
  type CartAddress,
  type CartGuardSettings,
  type CartInput,
  type CartLineInput,
  type GeoBlocklist,
  type QuantityLimit,
  type RawConfig,
  type RegexRule,
  type RuleConfig,
  type ViolationRule,
  MAX_ORDER_AMOUNT,
  MAX_PATTERN_LENGTH,
  MAX_REGEX_RULES,
  MAX_UNITS,
  MIN_VIP_ADDRESS_LENGTH,
  collectLimitTags,
  compileRegex,
  evaluateCart,
  isRecord,
  isRiskyPattern,
  normalizeText,
  parseConfig,
} from "../../extensions/cartguard-validator/src/rules";

export const CARTGUARD_NAMESPACE = "$app:cartguard";
export const LEGACY_NAMESPACE = "cartguard";
export const METAFIELD_TYPE = "json";
export const LEGACY_METAFIELD_TYPE = "single_line_text_field";
export const FUNCTION_CONFIG_KEY = "function-configuration";
export const CONFIG_KEYS = ["settings", "regex_rules", "quantity_limits", "geo_blocklist", "vip_allowlist"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Conservative per-value limit for metafields read by Shopify Functions. */
export const MAX_METAFIELD_BYTES = 10_000;
const MAX_MESSAGE_LENGTH = 250;
const MAX_QUANTITY_LIMITS = 50;
const MAX_LIST_ENTRIES = 500;
const MAX_ENTRY_LENGTH = 255;
const GEO_KEYS = ["countries", "zips", "cities", "states"] as const;
const GEO_LABELS: Record<(typeof GEO_KEYS)[number], string> = {
  countries: "countries",
  zips: "postal codes",
  cities: "cities",
  states: "states and provinces",
};

export type SectionErrors = Partial<Record<RuleSection, string>>;

/** One recent order the rules would have stopped. */
export type ImpactMatch = {
  /** Numeric order ID, for linking to the order in Shopify admin. */
  orderId: string | null;
  name: string;
  shipTo: string;
  reasons: string[];
  sections: RuleSection[];
};

export type ImpactResult = {
  scanned: number;
  blocked: number;
  /** Up to 5 one-line examples, for inline summaries. */
  samples: string[];
  /** Every order that would have been stopped. */
  matches: ImpactMatch[];
  /** Orders stopped by each section. An order can count in several. */
  bySection: Record<RuleSection, number>;
};

export type ActionResponse = {
  ok: boolean;
  saved?: boolean;
  needsConfirm?: boolean;
  impact?: ImpactResult;
  impactError?: string;
  validationWarning?: string;
  sectionErrors?: SectionErrors;
  message?: string;
};

/* Reading */

const SETTINGS_QUERY = `#graphql
  query CartGuardSettings {
    shop {
      id
      current: metafields(namespace: "$app:cartguard", first: 25) { nodes { key value } }
      legacy: metafields(namespace: "cartguard", first: 25) { nodes { key value } }
    }
  }
`;

type MetafieldNodes = { nodes?: Array<{ key?: string | null; value?: string | null } | null> | null } | null;

export type StoredConfiguration = {
  shopId: string;
  current: RawConfig | null;
  legacy: RawConfig | null;
};

function nodesToRaw(connection: MetafieldNodes | undefined): RawConfig | null {
  const raw: RawConfig = {};
  let found = false;
  for (const node of connection?.nodes ?? []) {
    const key = node?.key;
    if (key && (CONFIG_KEYS as readonly string[]).includes(key) && typeof node?.value === "string") {
      raw[key as ConfigKey] = node.value;
      found = true;
    }
  }
  return found ? raw : null;
}

export async function readConfiguration(admin: AdminApi): Promise<StoredConfiguration> {
  const { data } = await adminGraphql<{
    shop?: { id?: string; current?: MetafieldNodes; legacy?: MetafieldNodes } | null;
  }>(admin, SETTINGS_QUERY);
  const shopId = data.shop?.id;
  if (!shopId) throw new Error("Unable to load the shop from Shopify.");
  return { shopId, current: nodesToRaw(data.shop?.current), legacy: nodesToRaw(data.shop?.legacy) };
}

export function effectiveRaw(stored: StoredConfiguration): RawConfig {
  return stored.current ?? stored.legacy ?? {};
}

/* Validation */

const RELOAD_HINT = "Reload the page and try again.";

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** A list of strings, trimmed and without blanks. Null when the value isn't one. */
function readStringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return (value as string[]).map((entry) => entry.trim()).filter(Boolean);
}

function addressRuleLabel(rule: Record<string, unknown>): string {
  if (typeof rule.preset === "string" && Object.hasOwn(ADDRESS_PRESETS, rule.preset)) {
    return `The ${ADDRESS_PRESETS[rule.preset as AddressPreset].label}`;
  }
  if (rule.preset === "keywords") return "The blocked words rule";
  const text = typeof rule.street === "string" && rule.street ? rule.street : typeof rule.pattern === "string" ? rule.pattern : "";
  return text ? `The address rule for "${text.slice(0, 40)}"` : "An address rule";
}

/**
 * Reads the min/max unit and order-amount bounds of one limit, or null when the
 * value can't be saved. A bare number is the historical "max" shorthand.
 * Both readers answer null for anything absent, so presence is checked first.
 */
function readLimitBounds(key: string, value: unknown, add: (section: RuleSection, message: string) => void): QuantityLimit | null {
  const label = limitTargetLabel(key);
  const units = (raw: unknown): number | null => {
    // A bound of 0 would block every order containing the product, so the
    // smallest usable unit bound is 1 and "no bound" is left unset.
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_UNITS) return null;
    return raw;
  };
  const money = (raw: unknown): number | null => {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_ORDER_AMOUNT) return null;
    return Math.round(raw * 100) / 100;
  };

  if (typeof value === "number") {
    const max = units(value);
    if (max === null) {
      add("quantity", `${label}: the limit must be a whole number from 1 to ${formatNumber(MAX_UNITS)}.`);
      return null;
    }
    return { max };
  }
  if (!isRecord(value)) {
    add("quantity", `${label}: the limit couldn't be read. ${RELOAD_HINT}`);
    return null;
  }

  const present = (raw: unknown): boolean => raw !== undefined && raw !== null && raw !== "";
  const hasUnits = present(value.min) || present(value.max);
  const hasAmount = present(value.minAmount) || present(value.maxAmount);
  if (!hasUnits && !hasAmount) {
    add("quantity", `${label}: set a minimum, a maximum or an order amount, or remove this limit.`);
    return null;
  }

  const min = units(value.min);
  const max = units(value.max);
  const minAmount = money(value.minAmount);
  const maxAmount = money(value.maxAmount);
  if ((present(value.min) && min === null) || (present(value.max) && max === null)) {
    add("quantity", `${label}: unit limits must be whole numbers from 1 to ${formatNumber(MAX_UNITS)}.`);
    return null;
  }
  if ((present(value.minAmount) && minAmount === null) || (present(value.maxAmount) && maxAmount === null)) {
    add("quantity", `${label}: order amounts must be between 0 and ${formatNumber(MAX_ORDER_AMOUNT)}.`);
    return null;
  }
  // Amount bounds are order-wide; on a product-specific row they would be
  // ambiguous, so the editor moves them to the "Every product" limit.
  if (hasAmount && !isGlobalLimitKey(key)) {
    add("quantity", `${label}: order amounts only apply to the "Every product" limit.`);
    return null;
  }
  if (min !== null && max !== null && min > max) {
    add("quantity", `${label}: the minimum can't be more than the maximum.`);
    return null;
  }
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    add("quantity", `${label}: the smallest order can't be more than the largest one.`);
    return null;
  }

  const limit: QuantityLimit = {};
  if (min !== null) limit.min = min;
  if (max !== null) limit.max = max;
  if (minAmount !== null) limit.minAmount = minAmount;
  if (maxAmount !== null) limit.maxAmount = maxAmount;
  return limit;
}

const isGlobalLimitKey = (key: string): boolean => key === "*" || key.toLowerCase() === "all";

/**
 * Checks the structured rules submitted by the editor and returns the
 * normalized config, or merchant-language errors keyed by editor section.
 */
export function validateRuleConfig(input: unknown): { config: RuleConfig | null; errors: SectionErrors } {
  const errors: SectionErrors = {};
  const add = (section: RuleSection, message: string) => {
    errors[section] ??= message;
  };
  const body = isRecord(input) ? input : {};

  const rawSettings = isRecord(body.settings) ? body.settings : {};
  const settings = {} as CartGuardSettings;
  for (const flag of FEATURE_FLAGS) settings[flag] = rawSettings[flag] === true;

  // Addresses
  const regexRules: RegexRule[] = [];
  const rawRules = body.regexRules ?? [];
  if (!Array.isArray(rawRules)) {
    add("address", `Your address rules couldn't be read. ${RELOAD_HINT}`);
  } else {
    if (rawRules.length > MAX_REGEX_RULES) add("address", `You can have up to ${MAX_REGEX_RULES} address rules. Remove some and try again.`);
    for (const raw of rawRules.slice(0, MAX_REGEX_RULES)) {
      if (!isRecord(raw)) {
        add("address", `An address rule couldn't be read. ${RELOAD_HINT}`);
        continue;
      }
      const label = addressRuleLabel(raw);
      const pattern = typeof raw.pattern === "string" ? raw.pattern.trim() : "";
      if (!pattern) {
        add("address", `${label} is empty. Enter the text to block or remove it.`);
        continue;
      }
      if (pattern.length > MAX_PATTERN_LENGTH) {
        add("address", `${label} is longer than ${MAX_PATTERN_LENGTH} characters. Shorten it.`);
        continue;
      }
      if (!compileRegex(pattern)) {
        add("address", `${label} has a pattern that isn't valid.`);
        continue;
      }
      if (isRiskyPattern(pattern)) {
        add("address", `${label} could slow down checkout. Simplify the pattern.`);
        continue;
      }
      const rule: RegexRule = { pattern };
      if (raw.message !== undefined) {
        if (typeof raw.message !== "string" || raw.message.length > MAX_MESSAGE_LENGTH) {
          add("address", `${label} has a customer message longer than ${MAX_MESSAGE_LENGTH} characters.`);
          continue;
        }
        if (raw.message.trim()) rule.message = raw.message.trim();
      }
      if (raw.country !== undefined && raw.country !== "") {
        const code = typeof raw.country === "string" ? findCountry(raw.country) : null;
        if (!code) {
          add("address", `${label} is limited to a country we don't recognise. Choose one from the list.`);
          continue;
        }
        rule.country = code;
      }
      if (typeof raw.city === "string" && raw.city.trim()) {
        if (raw.city.length > MAX_ENTRY_LENGTH) {
          add("address", `${label} has a city name that's too long.`);
          continue;
        }
        rule.city = raw.city.trim();
      }
      if (typeof raw.preset === "string" && raw.preset.trim()) rule.preset = raw.preset.trim();
      const keywords = readStringList(raw.keywords);
      if (keywords && keywords.length > 0) rule.keywords = keywords;
      if (typeof raw.street === "string" && raw.street.trim()) rule.street = raw.street.trim();
      regexRules.push(rule);
    }
  }

  // Order quantities
  const quantityLimits: Record<string, QuantityLimit> = {};
  const rawLimits = body.quantityLimits ?? {};
  if (!isRecord(rawLimits)) {
    add("quantity", `Your quantity limits couldn't be read. ${RELOAD_HINT}`);
  } else {
    const entries = Object.entries(rawLimits);
    if (entries.length > MAX_QUANTITY_LIMITS) add("quantity", `You can have up to ${MAX_QUANTITY_LIMITS} quantity limits. Remove some and try again.`);
    for (const [rawKey, value] of entries.slice(0, MAX_QUANTITY_LIMITS)) {
      const key = rawKey.trim();
      if (!key || key.length > MAX_ENTRY_LENGTH) {
        add("quantity", "Every quantity limit needs a product tag, a product ID or Every product.");
        continue;
      }
      const label = limitTargetLabel(key);
      const bounds = readLimitBounds(key, value, add);
      if (!bounds) continue;
      let message: string | undefined;
      if (isRecord(value) && value.message !== undefined) {
        if (typeof value.message !== "string" || value.message.length > MAX_MESSAGE_LENGTH) {
          add("quantity", `${label}: keep the customer message under ${MAX_MESSAGE_LENGTH} characters.`);
          continue;
        }
        if (value.message.trim()) message = value.message.trim();
      }
      quantityLimits[key] = message ? { ...bounds, message } : bounds;
    }
  }

  // Countries and regions
  const geoBlocklist: GeoBlocklist = { countries: [], zips: [], cities: [], states: [] };
  const rawGeo = body.geoBlocklist ?? {};
  if (!isRecord(rawGeo)) {
    add("geo", `Your blocked areas couldn't be read. ${RELOAD_HINT}`);
  } else {
    for (const key of GEO_KEYS) {
      const list = readStringList(rawGeo[key]);
      if (!list) {
        add("geo", `Your blocked ${GEO_LABELS[key]} couldn't be read. ${RELOAD_HINT}`);
        continue;
      }
      if (list.length > MAX_LIST_ENTRIES) add("geo", `You can block up to ${MAX_LIST_ENTRIES} ${GEO_LABELS[key]}.`);
      if (list.some((entry) => entry.length > MAX_ENTRY_LENGTH)) add("geo", `One of your blocked ${GEO_LABELS[key]} is too long.`);
      geoBlocklist[key] = uniqueCaseInsensitive(list.slice(0, MAX_LIST_ENTRIES));
    }
    const resolved = geoBlocklist.countries.map((raw) => ({ raw, code: findCountry(raw) }));
    const unknown = resolved.filter((entry) => !entry.code).map((entry) => entry.raw);
    if (unknown.length > 0) {
      add("geo", `We don't recognise these countries: ${unknown.slice(0, 5).join(", ")}. Choose them from the list instead.`);
    }
    geoBlocklist.countries = uniqueCaseInsensitive(resolved.map((entry) => entry.code ?? entry.raw.toUpperCase()));
    const badStates = geoBlocklist.states.filter((entry) => !isValidStateEntry(entry));
    if (badStates.length > 0) {
      add("geo", `These states or provinces aren't valid: ${badStates.slice(0, 5).join(", ")}. Choose them from the list instead.`);
    }
  }

  // Trusted customers
  let vipAllowlist: string[] = [];
  const rawVip = readStringList(body.vipAllowlist);
  if (!rawVip) {
    add("vip", `Your trusted customers couldn't be read. ${RELOAD_HINT}`);
  } else {
    if (rawVip.length > MAX_LIST_ENTRIES) add("vip", `You can have up to ${MAX_LIST_ENTRIES} trusted customers.`);
    if (rawVip.some((entry) => entry.length > MAX_ENTRY_LENGTH)) add("vip", `A trusted customer entry is longer than ${MAX_ENTRY_LENGTH} characters.`);
    // Short address entries are ignored at checkout, so surface them instead of failing silently.
    const tooShort = rawVip.filter((entry) => {
      const normalized = normalizeText(entry);
      return normalized !== "" && !normalized.includes("@") && normalized.length < MIN_VIP_ADDRESS_LENGTH;
    });
    if (tooShort.length > 0) {
      add("vip", `Street addresses need at least ${MIN_VIP_ADDRESS_LENGTH} characters: ${tooShort.slice(0, 5).join(", ")}.`);
    }
    vipAllowlist = uniqueCaseInsensitive(rawVip.slice(0, MAX_LIST_ENTRIES));
  }

  const config: RuleConfig = { settings, regexRules, quantityLimits, geoBlocklist, vipAllowlist };

  // Size limits for checkout
  if (Object.keys(errors).length === 0) {
    const values = serializeConfig(config);
    const sizeChecks: Array<[ConfigKey, RuleSection]> = [
      ["regex_rules", "address"],
      ["quantity_limits", "quantity"],
      ["geo_blocklist", "geo"],
      ["vip_allowlist", "vip"],
    ];
    for (const [key, section] of sizeChecks) {
      if (byteLength(values[key]) > MAX_METAFIELD_BYTES) {
        add(section, `This section is too large for Shopify checkout (over ${MAX_METAFIELD_BYTES / 1000} KB). Remove some entries.`);
      }
    }
  }

  return Object.keys(errors).length > 0 ? { config: null, errors } : { config, errors };
}

export function serializeConfig(config: RuleConfig): Record<ConfigKey, string> {
  // Only the fields the merchant set are written, so a limit with just a
  // maximum stays a small object and never carries empty bounds.
  const quantity: Record<string, QuantityLimit> = {};
  for (const [key, limit] of Object.entries(config.quantityLimits)) {
    quantity[key] = { ...limit };
  }
  return {
    settings: JSON.stringify(config.settings),
    regex_rules: JSON.stringify(config.regexRules),
    quantity_limits: JSON.stringify(quantity),
    geo_blocklist: JSON.stringify(config.geoBlocklist),
    vip_allowlist: JSON.stringify(config.vipAllowlist),
  };
}

/* Writing */

export async function writeShopConfiguration(admin: AdminApi, shopId: string, config: RuleConfig): Promise<void> {
  const values = serializeConfig(config);
  await setMetafields(
    admin,
    CONFIG_KEYS.map((key) => ({ ownerId: shopId, namespace: CARTGUARD_NAMESPACE, key, type: METAFIELD_TYPE, value: values[key] })),
  );
}

/** Input query variables for the Function, stored on the Validation owner. */
export async function writeFunctionConfiguration(admin: AdminApi, validationId: string, config: RuleConfig): Promise<void> {
  await setMetafields(admin, [
    {
      ownerId: validationId,
      namespace: CARTGUARD_NAMESPACE,
      key: FUNCTION_CONFIG_KEY,
      type: METAFIELD_TYPE,
      value: JSON.stringify({ limitTags: collectLimitTags(config.quantityLimits) }),
    },
  ]);
}

const METAFIELDS_DELETE_MUTATION = `#graphql
  mutation CartGuardDeleteLegacy($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }
`;

export async function deleteLegacyMetafields(admin: AdminApi, shopId: string): Promise<void> {
  const { data } = await adminGraphql<{
    metafieldsDelete?: { userErrors?: Array<{ message: string }> | null } | null;
  }>(admin, METAFIELDS_DELETE_MUTATION, {
    metafields: CONFIG_KEYS.map((key) => ({ ownerId: shopId, namespace: LEGACY_NAMESPACE, key })),
  });
  const userErrors = data.metafieldsDelete?.userErrors ?? [];
  if (userErrors.length > 0) throw new Error(userErrors.map((e) => e.message).join("; "));
}

/**
 * Saves the rules, then makes sure CartGuard's checkout rule exists, is
 * enabled and has the tag list it needs. A failure in the second part doesn't
 * undo the save; it's returned as a warning for the merchant.
 */
export async function saveConfiguration(admin: AdminApi, config: RuleConfig): Promise<{ validationWarning?: string }> {
  const stored = await readConfiguration(admin);
  await writeShopConfiguration(admin, stored.shopId, config);

  let validationWarning: string | undefined;
  try {
    const validationId = await ensureValidationEnabled(admin);
    await writeFunctionConfiguration(admin, validationId, config);
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[CartGuard] Rules saved but the checkout rule couldn't be activated:", errorMessage(error));
    validationWarning = friendlyErrorMessage(error);
  }

  if (stored.legacy) {
    try {
      await deleteLegacyMetafields(admin, stored.shopId);
    } catch (error) {
      if (error instanceof Response) throw error;
      console.warn("[CartGuard] Could not delete legacy metafields:", errorMessage(error));
    }
  }

  return { validationWarning };
}

/* Impact Checker */

const IMPACT_PAGE_SIZE = 10;
const IMPACT_MAX_ORDERS = 100;
const IMPACT_MIN_BUDGET = 800;
const IMPACT_SAMPLE_LIMIT = 5;

// 10 orders x (order + address + 40 line items x (item + product)) is about
// 820 points, under the 1,000-point single-query limit.
const RECENT_ORDERS_QUERY = `#graphql
  query CartGuardRecentOrders($first: Int!, $after: String) {
    orders(first: $first, after: $after, reverse: true, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        email
        shippingAddress { address1 address2 city provinceCode zip countryCode }
        currencyCode
        lineItems(first: 40) {
          nodes {
            quantity
            originalTotalSet {
              shopMoney { amount }
            }
            product { id tags }
          }
        }
      }
    }
  }
`;

type Money = { amount?: string | null } | null;

type OrderNode = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  currencyCode?: string | null;
  shippingAddress?: CartAddress | null;
  lineItems?: {
    nodes?: Array<{
      quantity?: number | null;
      /** Line total, used for amount limits. */
      originalTotalSet?: { shopMoney?: Money } | null;
      product?: { id?: string | null; tags?: string[] | null } | null;
    } | null> | null;
  } | null;
};

function toAmount(money: Money | undefined): number | null {
  const amount = Number(money?.amount);
  return Number.isFinite(amount) ? amount : null;
}

function orderToCart(order: OrderNode, limitTags: Set<string>): CartInput {
  const lines: CartLineInput[] = [];
  const items = Array.isArray(order.lineItems?.nodes) ? order.lineItems.nodes : [];
  items.forEach((item, index) => {
    const productId = item?.product?.id;
    if (!productId) return;
    // Checkout only learns about the tags in collectLimitTags (product.hasTags),
    // so the simulation must see exactly the same subset.
    const rawTags = item?.product?.tags;
    const tags = (Array.isArray(rawTags) ? rawTags : [])
      .filter((tag): tag is string => typeof tag === "string" && limitTags.has(tag.trim().toLowerCase()));
    const quantity = Number(item?.quantity ?? 0);
    const lineTotal = toAmount(item?.originalTotalSet?.shopMoney);
    lines.push({
      index,
      productId,
      quantity,
      tags,
      unitPrice: lineTotal !== null && Number.isFinite(quantity) && quantity > 0 ? lineTotal / quantity : null,
    });
  });
  return {
    email: order.email ?? null,
    // Approximation: without read_customers the Admin API can't tell whether
    // the buyer was signed in, so the order email stands in for the account email.
    customerEmail: order.email ?? null,
    lines,
    addresses: order.shippingAddress ? [{ groupIndex: 0, address: order.shippingAddress }] : [],
    currencyCode: order.currencyCode ?? null,
  };
}

const VIOLATION_SECTION: Record<ViolationRule, RuleSection> = {
  country: "geo",
  zip: "geo",
  city: "geo",
  state: "geo",
  address: "address",
  quantity: "quantity",
  amount: "quantity",
};

const capitalize = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

function describeShipTo(address: CartAddress | null | undefined): string {
  if (!address) return "No shipping address";
  const country = address.countryCode ? countryName(address.countryCode) : null;
  return [address.city, address.provinceCode, country].filter(Boolean).join(", ") || "No shipping address";
}

export function simulateOrders(orders: OrderNode[], config: RuleConfig): ImpactResult {
  let blocked = 0;
  const samples: string[] = [];
  const matches: ImpactMatch[] = [];
  const bySection: Record<RuleSection, number> = { geo: 0, address: 0, quantity: 0, vip: 0 };
  const limitTags = new Set(collectLimitTags(config.quantityLimits).map((tag) => tag.trim().toLowerCase()));
  for (const order of orders) {
    const violations = evaluateCart(orderToCart(order, limitTags), config);
    if (violations.length === 0) continue;
    blocked += 1;
    const orderId = order.id?.split("/").pop() ?? null;
    const label = order.name || (orderId ? `Order ${orderId}` : "Order");
    if (samples.length < IMPACT_SAMPLE_LIMIT) {
      samples.push(`${label}: ${violations.slice(0, 2).map((v) => v.detail).join("; ")}`);
    }
    const sections = [...new Set(violations.map((violation) => VIOLATION_SECTION[violation.rule]))];
    for (const section of sections) bySection[section] += 1;
    matches.push({
      orderId,
      name: label,
      shipTo: describeShipTo(order.shippingAddress),
      reasons: violations.map((violation) => capitalize(violation.detail)),
      sections,
    });
  }
  return { scanned: orders.length, blocked, samples, matches, bySection };
}

type OrdersQueryResult = {
  orders?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: OrderNode[] } | null;
};

export async function simulateImpact(admin: AdminApi, config: RuleConfig): Promise<ImpactResult> {
  const orders: OrderNode[] = [];
  let after: string | null = null;
  // Shopify can return the same cursor again (a buggy pageInfo, or a cursor it
  // did not advance). The loop is bounded by orders scanned, so a page that
  // yields no nodes would otherwise spin until the budget check or forever.
  const seenCursors = new Set<string>();
  while (orders.length < IMPACT_MAX_ORDERS) {
    const queryResult: { data: OrdersQueryResult; cost?: GraphqlCost } = await adminGraphql<OrdersQueryResult>(
      admin,
      RECENT_ORDERS_QUERY,
      { first: IMPACT_PAGE_SIZE, after },
    );
    const page: OrdersQueryResult["orders"] = queryResult.data.orders;
    const nodes = page?.nodes ?? [];
    orders.push(...nodes);
    const cursor = page?.pageInfo?.endCursor ?? null;
    if (!page?.pageInfo?.hasNextPage || !cursor) break;
    if (seenCursors.has(cursor) || nodes.length === 0) break;
    seenCursors.add(cursor);
    after = cursor;
    const available = queryResult.cost?.throttleStatus?.currentlyAvailable;
    if (typeof available === "number" && available < IMPACT_MIN_BUDGET) break;
  }
  return simulateOrders(orders.slice(0, IMPACT_MAX_ORDERS), config);
}

/** Re-exported for the rules route. */
export { parseConfig };
