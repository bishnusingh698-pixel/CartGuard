/**
 * CartGuard server helpers for the admin app.
 *
 * - Configuration lives in app-owned shop metafields ($app:cartguard, type
 *   json). Other apps and staff can't edit them. Values saved by older builds
 *   under the public "cartguard" namespace are read as a fallback and removed
 *   on the next save.
 * - Strict validation of drafts (save-time quality gate; checkout stays
 *   fail-open).
 * - Impact Checker: simulates the rules on recent orders using the same rule
 *   engine as the checkout Function (extensions/cartguard-validator/src/rules.ts).
 */

import { type AdminApi, type GraphqlCost, adminGraphql, errorMessage, setMetafields } from "./admin-api.server";
import { ensureValidationEnabled } from "./validation.server";
import {
  type CartAddress,
  type CartGuardSettings,
  type CartInput,
  type CartLineInput,
  type QuantityLimit,
  type RawConfig,
  type RuleConfig,
  MAX_PATTERN_LENGTH,
  MAX_REGEX_RULES,
  collectLimitTags,
  compileRegex,
  evaluateCart,
  isRecord,
  isRiskyPattern,
  MIN_VIP_ADDRESS_LENGTH,
  normalizeText,
  parseConfig,
  parseGeoBlocklist,
  parseQuantityLimits,
  parseRegexRules,
  parseVipAllowlist,
  resolveCountryCode,
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

export type DraftConfig = Record<Exclude<ConfigKey, "settings">, string>;

export type ImpactResult = {
  scanned: number;
  blocked: number;
  samples: string[];
};

export type ActionResponse = {
  ok: boolean;
  saved?: boolean;
  needsConfirm?: boolean;
  impact?: ImpactResult;
  impactError?: string;
  validationWarning?: string;
  fieldErrors?: Record<string, string>;
  message?: string;
};

/* ── Reading ──────────────────────────────────────────────────────────────── */

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

/* ── Validation ──────────────────────────────────────────────────────────── */

const INVALID = Symbol("invalid-json");

function strictParse(raw: string, fallback: unknown): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return INVALID;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function validateDraftConfig(draft: DraftConfig): Record<string, string> {
  const errors: Record<string, string> = {};
  const add = (field: keyof DraftConfig, message: string) => {
    if (!errors[field]) errors[field] = message;
  };

  // Address rules
  const regex = strictParse(draft.regex_rules, []);
  if (regex === INVALID) add("regex_rules", "Address rules must be valid JSON.");
  else if (!Array.isArray(regex)) add("regex_rules", "Address rules must be a JSON array of { pattern, message } objects.");
  else {
    if (regex.length > MAX_REGEX_RULES) add("regex_rules", `Use at most ${MAX_REGEX_RULES} address rules.`);
    regex.forEach((rule, index) => {
      const n = index + 1;
      if (!isRecord(rule)) return add("regex_rules", `Rule ${n} must be an object.`);
      if (typeof rule.pattern !== "string" || !rule.pattern.trim()) return add("regex_rules", `Rule ${n}: "pattern" must be a non-empty string.`);
      if (rule.pattern.length > MAX_PATTERN_LENGTH) return add("regex_rules", `Rule ${n}: the pattern is longer than ${MAX_PATTERN_LENGTH} characters.`);
      if (!compileRegex(rule.pattern)) return add("regex_rules", `Rule ${n}: "${rule.pattern}" is not a valid regular expression.`);
      if (isRiskyPattern(rule.pattern)) {
        return add("regex_rules", `Rule ${n}: nested repetition such as (a+)+ or back-references can stall checkout. Simplify the pattern.`);
      }
      if (rule.message !== undefined && typeof rule.message !== "string") return add("regex_rules", `Rule ${n}: "message" must be a string.`);
      if (typeof rule.message === "string" && rule.message.length > MAX_MESSAGE_LENGTH) return add("regex_rules", `Rule ${n}: the message is longer than ${MAX_MESSAGE_LENGTH} characters.`);
      if (rule.country !== undefined) {
        if (typeof rule.country !== "string") return add("regex_rules", `Rule ${n}: "country" must be a string.`);
        if (rule.country.trim() && !resolveCountryCode(rule.country)) {
          return add("regex_rules", `Rule ${n}: unknown country "${rule.country}". Use a 2-letter ISO code such as CR or KZ.`);
        }
      }
      if (rule.city !== undefined && typeof rule.city !== "string") return add("regex_rules", `Rule ${n}: "city" must be a string.`);
      return undefined;
    });
  }

  // Quantity limits
  const quantity = strictParse(draft.quantity_limits, {});
  if (quantity === INVALID) add("quantity_limits", "Quantity limits must be valid JSON.");
  else if (!isRecord(quantity)) add("quantity_limits", 'Quantity limits must be a JSON object such as { "bulk": 10 }.');
  else {
    const entries = Object.entries(quantity);
    if (entries.length > MAX_QUANTITY_LIMITS) add("quantity_limits", `Use at most ${MAX_QUANTITY_LIMITS} quantity limits.`);
    for (const [key, value] of entries) {
      if (!key.trim()) {
        add("quantity_limits", "Every quantity limit needs a product tag, product ID or \"all\".");
        continue;
      }
      const max = typeof value === "number" ? value : isRecord(value) ? Number(value.max) : Number.NaN;
      if (!Number.isInteger(max) || max < 1 || max > 1_000_000) {
        add("quantity_limits", `"${key}": the limit must be a whole number of at least 1.`);
      }
      if (isRecord(value) && value.message !== undefined && typeof value.message !== "string") {
        add("quantity_limits", `"${key}": "message" must be a string.`);
      }
    }
  }

  // Geographic blocklist
  const geo = strictParse(draft.geo_blocklist, {});
  if (geo === INVALID) add("geo_blocklist", "The geographic blocklist must be valid JSON.");
  else if (!isRecord(geo)) add("geo_blocklist", 'The geographic blocklist must be a JSON object with "countries", "zips", "cities" and "states" arrays.');
  else {
    for (const key of Object.keys(geo)) {
      if (!(GEO_KEYS as readonly string[]).includes(key)) add("geo_blocklist", `Unknown key "${key}". Use countries, zips, cities or states.`);
    }
    for (const key of GEO_KEYS) {
      const list = geo[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
        add("geo_blocklist", `"${key}" must be an array of strings.`);
        continue;
      }
      if (list.length > MAX_LIST_ENTRIES) add("geo_blocklist", `"${key}" can have at most ${MAX_LIST_ENTRIES} entries.`);
      if (list.some((entry: string) => entry.length > MAX_ENTRY_LENGTH)) add("geo_blocklist", `"${key}" has an entry longer than ${MAX_ENTRY_LENGTH} characters.`);
    }
    if (Array.isArray(geo.countries)) {
      const unresolved = geo.countries.filter(
        (country: unknown): country is string =>
          typeof country === "string" && country.trim() !== "" && !resolveCountryCode(country),
      );
      if (unresolved.length > 0) {
        add("geo_blocklist", `Unknown countries: ${unresolved.slice(0, 5).join(", ")}. Use 2-letter ISO codes such as US, CR or KZ.`);
      }
    }
  }

  // VIP allowlist
  const vip = strictParse(draft.vip_allowlist, []);
  if (vip === INVALID) add("vip_allowlist", "The VIP allowlist must be valid JSON.");
  else if (!Array.isArray(vip) || vip.some((entry) => typeof entry !== "string")) {
    add("vip_allowlist", "The VIP allowlist must be a JSON array of email addresses or street addresses.");
  } else {
    if (vip.length > MAX_LIST_ENTRIES) add("vip_allowlist", `The VIP allowlist can have at most ${MAX_LIST_ENTRIES} entries.`);
    if (vip.some((entry: string) => entry.length > MAX_ENTRY_LENGTH)) add("vip_allowlist", `A VIP entry is longer than ${MAX_ENTRY_LENGTH} characters.`);
    // Short address entries are ignored at checkout, so surface them instead of failing silently.
    const tooShort = vip.filter((entry: string) => {
      const normalized = normalizeText(entry);
      return normalized !== "" && !normalized.includes("@") && normalized.length < MIN_VIP_ADDRESS_LENGTH;
    });
    if (tooShort.length > 0) {
      add("vip_allowlist", `Street addresses need at least ${MIN_VIP_ADDRESS_LENGTH} characters: ${tooShort.slice(0, 5).join(", ")}.`);
    }
  }

  // Size limits for checkout
  if (Object.keys(errors).length === 0) {
    const values = serializeConfig(
      parseDraftConfig(draft, { enable_vip: false, enable_po_box: false, enable_quantity: false, enable_geo: false }),
    );
    for (const key of ["regex_rules", "quantity_limits", "geo_blocklist", "vip_allowlist"] as const) {
      if (byteLength(values[key]) > MAX_METAFIELD_BYTES) {
        add(key, `This list is too large for Shopify checkout (over ${MAX_METAFIELD_BYTES / 1000} KB). Remove some entries.`);
      }
    }
  }

  return errors;
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

/** Tolerant parse + normalization. Call after validateDraftConfig passed. */
export function parseDraftConfig(draft: DraftConfig, settings: CartGuardSettings): RuleConfig {
  const regexRules = parseRegexRules(draft.regex_rules)
    .slice(0, MAX_REGEX_RULES)
    .map((rule) => (rule.country ? { ...rule, country: resolveCountryCode(rule.country) ?? rule.country.toUpperCase() } : rule));
  const geo = parseGeoBlocklist(draft.geo_blocklist);
  return {
    settings: { ...settings },
    regexRules,
    quantityLimits: parseQuantityLimits(draft.quantity_limits),
    geoBlocklist: {
      countries: uniqueCaseInsensitive(geo.countries.map((c) => resolveCountryCode(c) ?? c.toUpperCase())),
      zips: uniqueCaseInsensitive(geo.zips),
      cities: uniqueCaseInsensitive(geo.cities),
      states: uniqueCaseInsensitive(geo.states),
    },
    vipAllowlist: uniqueCaseInsensitive(parseVipAllowlist(draft.vip_allowlist)),
  };
}

export function serializeConfig(config: RuleConfig): Record<ConfigKey, string> {
  const quantity: Record<string, number | QuantityLimit> = {};
  for (const [key, limit] of Object.entries(config.quantityLimits)) {
    quantity[key] = limit.message ? { max: limit.max, message: limit.message } : limit.max;
  }
  return {
    settings: JSON.stringify(config.settings),
    regex_rules: JSON.stringify(config.regexRules),
    quantity_limits: JSON.stringify(quantity),
    geo_blocklist: JSON.stringify(config.geoBlocklist),
    vip_allowlist: JSON.stringify(config.vipAllowlist),
  };
}

/* ── Writing ──────────────────────────────────────────────────────────────── */

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
    validationWarning = errorMessage(error);
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

/* ── Impact Checker ──────────────────────────────────────────────────────── */

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
        lineItems(first: 40) {
          nodes {
            quantity
            product { id tags }
          }
        }
      }
    }
  }
`;

type OrderNode = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  shippingAddress?: CartAddress | null;
  lineItems?: {
    nodes?: Array<{ quantity?: number | null; product?: { id?: string | null; tags?: string[] | null } | null } | null> | null;
  } | null;
};

function orderToCart(order: OrderNode, limitTags: Set<string>): CartInput {
  const lines: CartLineInput[] = [];
  (order.lineItems?.nodes ?? []).forEach((item, index) => {
    const productId = item?.product?.id;
    if (!productId) return;
    // Checkout only learns about the tags in collectLimitTags (product.hasTags),
    // so the simulation must see exactly the same subset.
    const tags = (item?.product?.tags ?? []).filter(
      (tag): tag is string => typeof tag === "string" && limitTags.has(tag.trim().toLowerCase()),
    );
    lines.push({ index, productId, quantity: Number(item?.quantity ?? 0), tags });
  });
  return {
    email: order.email ?? null,
    // Approximation: without read_customers the Admin API can't tell whether
    // the buyer was signed in, so the order email stands in for the account email.
    customerEmail: order.email ?? null,
    lines,
    addresses: order.shippingAddress ? [{ groupIndex: 0, address: order.shippingAddress }] : [],
  };
}

export function simulateOrders(orders: OrderNode[], config: RuleConfig): ImpactResult {
  let blocked = 0;
  const samples: string[] = [];
  const limitTags = new Set(collectLimitTags(config.quantityLimits).map((tag) => tag.trim().toLowerCase()));
  for (const order of orders) {
    const violations = evaluateCart(orderToCart(order, limitTags), config);
    if (violations.length === 0) continue;
    blocked += 1;
    if (samples.length < IMPACT_SAMPLE_LIMIT) {
      const label = order.name || (order.id ? `Order ${order.id.split("/").pop()}` : "Order");
      samples.push(`${label}: ${violations.slice(0, 2).map((v) => v.detail).join("; ")}`);
    }
  }
  return { scanned: orders.length, blocked, samples };
}

type OrdersQueryResult = {
  orders?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: OrderNode[] } | null;
};

export async function simulateImpact(admin: AdminApi, config: RuleConfig): Promise<ImpactResult> {
  const orders: OrderNode[] = [];
  let after: string | null = null;
  while (orders.length < IMPACT_MAX_ORDERS) {
    const queryResult: { data: OrdersQueryResult; cost?: GraphqlCost } = await adminGraphql<OrdersQueryResult>(
      admin,
      RECENT_ORDERS_QUERY,
      { first: IMPACT_PAGE_SIZE, after },
    );
    const page: OrdersQueryResult["orders"] = queryResult.data.orders;
    orders.push(...(page?.nodes ?? []));
    if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
    const available = queryResult.cost?.throttleStatus?.currentlyAvailable;
    if (typeof available === "number" && available < IMPACT_MIN_BUDGET) break;
  }
  return simulateOrders(orders.slice(0, IMPACT_MAX_ORDERS), config);
}

/** Re-exported for the settings route. */
export { parseConfig };
