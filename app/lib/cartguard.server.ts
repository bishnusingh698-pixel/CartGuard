/**
 * CartGuard — server helpers for the Remix admin app.
 *
 * Responsibilities:
 *   - Shop metafield contract (namespace "cartguard", single_line_text_field).
 *   - Strict JSON validation for the settings form (save-time quality gate).
 *   - Impact Checker: fetch the last 100 orders via Admin GraphQL and simulate
 *     the Function rules in memory (Feature 6).
 *   - Persistence via `metafieldsSet` on the Shop owner.
 *
 * NOTE: the rule simulation below deliberately mirrors
 * `extensions/cartguard-validator/src/run.ts`. Keep the two in sync when rules
 * change. The simulator is *stronger* than the checkout Function in one aspect:
 * Admin orders expose real billing addresses, so the Smart Mismatch Detector
 * is simulated fully (see run.ts for the checkout-side fallback behaviour).
 */

export const CARTGUARD_NAMESPACE = "cartguard";
export const METAFIELD_TYPE = "single_line_text_field";

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

export const FEATURE_FLAGS = [
  "enable_vip",
  "enable_po_box",
  "enable_quantity",
  "enable_geo",
  "enable_mismatch",
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export type CartGuardSettings = Record<FeatureFlag, boolean>;

export type DraftConfig = {
  settings: CartGuardSettings;
  regex_rules: string;
  quantity_limits: string;
  geo_blocklist: string;
  vip_allowlist: string;
};

export type RegexRule = {
  pattern: string;
  country?: string;
  city?: string;
  message?: string;
};

export type GeoBlocklist = {
  zips: string[];
  cities: string[];
  states: string[];
  countries: string[];
};

export type ParsedRules = {
  regexRules: RegexRule[];
  quantityLimits: Record<string, number | { max: number; message?: string }>;
  geoBlocklist: GeoBlocklist;
  vipAllowlist: string[];
};

export type ImpactResult = {
  scanned: number;
  blocked: number;
  /** Human-readable examples, capped for UI display. */
  samples: string[];
};

export type ActionResponse = {
  ok: boolean;
  saved?: boolean;
  needsConfirm?: boolean;
  impact?: ImpactResult;
  fieldErrors?: Record<string, string>;
  message?: string;
};

export type AdminApi = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Parsing helpers
 * ──────────────────────────────────────────────────────────────────────────── */

export function safeJsonParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function parseSettings(raw: string | null | undefined): CartGuardSettings {
  const parsed = safeJsonParse<Partial<CartGuardSettings>>(raw);
  const result = {} as CartGuardSettings;
  for (const flag of FEATURE_FLAGS) {
    result[flag] = parsed?.[flag] === true;
  }
  return result;
}

/** Pretty-print stored JSON for text areas, falling back to an example. */
export function prettyJson(raw: string | null | undefined, fallback: string): string {
  const parsed = safeJsonParse<unknown>(raw);
  if (parsed === null || parsed === undefined) return fallback;
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return fallback;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Strict validation (save-time quality gate — runtime stays fail-open)
 * ──────────────────────────────────────────────────────────────────────────── */

const EMPTY_DEFAULTS: Record<keyof Omit<DraftConfig, "settings">, string> = {
  regex_rules: "[]",
  quantity_limits: "{}",
  geo_blocklist: "{}",
  vip_allowlist: "[]",
};

export function validateDraftConfig(
  draft: Omit<DraftConfig, "settings">,
): Record<string, string> {
  const fieldErrors: Record<string, string> = {};

  const regexRules = safeJsonParse<unknown[]>(draft.regex_rules.trim() || EMPTY_DEFAULTS.regex_rules);
  if (!Array.isArray(regexRules)) {
    fieldErrors.regex_rules = "Expected a JSON array of { pattern, message } objects.";
  } else {
    regexRules.forEach((rule, index) => {
      const entry = rule as { pattern?: unknown; message?: unknown; country?: unknown; city?: unknown };
      if (typeof entry?.pattern !== "string" || entry.pattern.trim().length === 0) {
        fieldErrors.regex_rules = `Rule ${index + 1}: "pattern" must be a non-empty string.`;
      } else {
        try {
          new RegExp(entry.pattern, "iu");
        } catch {
          try {
            new RegExp(entry.pattern, "i");
          } catch (error) {
            fieldErrors.regex_rules = `Rule ${index + 1}: invalid regex — ${(error as Error).message}`;
          }
        }
      }
      if (entry?.message !== undefined && typeof entry.message !== "string") {
        fieldErrors.regex_rules = `Rule ${index + 1}: "message" must be a string.`;
      }
      if (entry?.country !== undefined && typeof entry.country !== "string") {
        fieldErrors.regex_rules = `Rule ${index + 1}: "country" must be a string (e.g. "CR", "KZ").`;
      }
      if (entry?.city !== undefined && typeof entry.city !== "string") {
        fieldErrors.regex_rules = `Rule ${index + 1}: "city" must be a string.`;
      }
    });
  }

  const quantityLimits = safeJsonParse<Record<string, unknown>>(
    draft.quantity_limits.trim() || EMPTY_DEFAULTS.quantity_limits,
  );
  if (!quantityLimits || typeof quantityLimits !== "object" || Array.isArray(quantityLimits)) {
    fieldErrors.quantity_limits = "Expected a JSON object of { tag: max }.";
  } else {
    for (const [tag, value] of Object.entries(quantityLimits)) {
      const max = typeof value === "number" ? value : Number((value as { max?: unknown })?.max);
      if (!tag.trim()) continue; // gracefully ignore empty tags rather than blocking save
      if (!Number.isFinite(max) || max <= 0) {
        fieldErrors.quantity_limits = `Tag "${tag}": limit must be a positive number.`;
      }
    }
  }

  const geo = safeJsonParse<{ zips?: unknown; cities?: unknown; states?: unknown; countries?: unknown }>(
    draft.geo_blocklist.trim() || EMPTY_DEFAULTS.geo_blocklist,
  );
  if (!geo || typeof geo !== "object" || Array.isArray(geo)) {
    fieldErrors.geo_blocklist = 'Expected a JSON object with "zips", "cities", "states", "countries" arrays.';
  } else {
    for (const key of ["zips", "cities", "states", "countries"] as const) {
      const list = geo[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
        fieldErrors.geo_blocklist = `"${key}" must be an array of strings.`;
      }
    }
  }

  const vip = safeJsonParse<unknown[]>(draft.vip_allowlist.trim() || EMPTY_DEFAULTS.vip_allowlist);
  if (!Array.isArray(vip) || vip.some((entry) => typeof entry !== "string")) {
    fieldErrors.vip_allowlist = "Expected a JSON array of email or address strings.";
  }

  return fieldErrors;
}

/** Tolerant parse (runs after validateDraftConfig has already gated the save). */
export function parseDraftConfig(
  draft: Omit<DraftConfig, "settings">,
): ParsedRules {
  const regexRules: ParsedRules["regexRules"] = [];
  const parsedRegex = safeJsonParse<Array<{ pattern?: unknown; message?: unknown }>>(
    draft.regex_rules.trim() || EMPTY_DEFAULTS.regex_rules,
  );
  if (Array.isArray(parsedRegex)) {
    for (const rule of parsedRegex) {
      if (typeof rule?.pattern === "string" && rule.pattern.trim()) {
        const item = rule as { pattern: string; country?: unknown; city?: unknown; message?: unknown };
        regexRules.push({
          pattern: item.pattern,
          ...(typeof item.country === "string" && item.country.trim()
            ? { country: item.country.trim() }
            : {}),
          ...(typeof item.city === "string" && item.city.trim()
            ? { city: item.city.trim() }
            : {}),
          ...(typeof item.message === "string" && item.message.trim()
            ? { message: item.message.trim() }
            : {}),
        });
      }
    }
  }

  const quantityLimits: ParsedRules["quantityLimits"] = {};
  const parsedLimits = safeJsonParse<Record<string, unknown>>(
    draft.quantity_limits.trim() || EMPTY_DEFAULTS.quantity_limits,
  );
  if (parsedLimits && typeof parsedLimits === "object" && !Array.isArray(parsedLimits)) {
    for (const [tag, value] of Object.entries(parsedLimits)) {
      if (!tag.trim()) continue;
      const max = typeof value === "number" ? value : Number((value as { max?: unknown })?.max);
      if (Number.isFinite(max) && max > 0) {
        quantityLimits[tag] =
          typeof value === "object" && value && typeof (value as { message?: unknown }).message === "string"
            ? { max, message: (value as { message: string }).message }
            : max;
      }
    }
  }

  const geoSource = safeJsonParse<{ zips?: unknown; cities?: unknown; states?: unknown; countries?: unknown }>(
    draft.geo_blocklist.trim() || EMPTY_DEFAULTS.geo_blocklist,
  );
  const toStringArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  const geoBlocklist = {
    zips: toStringArray(geoSource?.zips),
    cities: toStringArray(geoSource?.cities),
    states: toStringArray(geoSource?.states),
    countries: toStringArray(geoSource?.countries),
  };

  const vipSource = safeJsonParse<unknown[]>(
    draft.vip_allowlist.trim() || EMPTY_DEFAULTS.vip_allowlist,
  );
  const vipAllowlist = toStringArray(vipSource);

  return { regexRules, quantityLimits, geoBlocklist, vipAllowlist };
}

/* ────────────────────────────────────────────────────────────────────────────
 * GraphQL documents
 * ──────────────────────────────────────────────────────────────────────────── */

export const CARTGUARD_METAFIELDS_QUERY = /* GraphQL */ `
  query CartGuardSettings {
    shop {
      metafields(namespace: "cartguard", first: 10) {
        nodes {
          key
          value
        }
      }
    }
  }
`;

export const SHOP_CONTEXT_QUERY = /* GraphQL */ `
  query CartGuardShopContext {
    shop {
      id
    }
  }
`;

export const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation CartGuardSave($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
      metafields {
        id
        key
      }
    }
  }
`;

/**
 * Last 100 orders for the Impact Checker.
 * NOTE: `Order.email` and `Customer.emailAddress` — if a future API version
 * removes/renames either, delete the affected line; the simulator falls back
 * to the other source automatically.
 */
export const LAST_ORDERS_QUERY = /* GraphQL */ `
  query CartGuardLastOrders($first: Int!) {
    orders(first: $first, reverse: true, sortKey: CREATED_AT) {
      nodes {
        id
        name
        createdAt
        email
        customer {
          emailAddress {
            emailAddress
          }
        }
        shippingAddress {
          address1
          address2
          city
          provinceCode
          zip
          countryCode
        }
        billingAddress {
          address1
          city
          provinceCode
          zip
          countryCode
        }
        lineItems(first: 50) {
          nodes {
            quantity
            variant {
              product {
                id
                tags
              }
            }
          }
        }
      }
    }
  }
`;

/* ────────────────────────────────────────────────────────────────────────────
 * Persistence — metafieldsSet on the Shop owner
 * ──────────────────────────────────────────────────────────────────────────── */

export async function writeConfiguration(
  admin: AdminApi,
  rules: ParsedRules,
  settings: CartGuardSettings,
): Promise<void> {
  const shopResponse = await admin.graphql(SHOP_CONTEXT_QUERY);
  const shopBody = (await shopResponse.json()) as {
    data?: { shop?: { id?: string } };
  };
  const shopId = shopBody?.data?.shop?.id;
  if (!shopId) {
    throw new Error("Unable to resolve the Shop id for metafield writes.");
  }

  const values: Record<string, string> = {
    settings: JSON.stringify(settings),
    regex_rules: JSON.stringify(rules.regexRules),
    quantity_limits: JSON.stringify(rules.quantityLimits),
    geo_blocklist: JSON.stringify(rules.geoBlocklist),
    vip_allowlist: JSON.stringify(rules.vipAllowlist),
  };

  const metafields = Object.entries(values).map(([key, value]) => ({
    ownerId: shopId,
    namespace: CARTGUARD_NAMESPACE,
    key,
    type: METAFIELD_TYPE,
    value,
  }));

  const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
    variables: { metafields },
  });
  const body = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        userErrors?: Array<{ field?: string[]; message?: string }>;
      };
    };
  };

  const userErrors = body?.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    // If the generic mutation ever rejects the Shop owner type, fall back to
    // the dedicated `shopMetafieldsSet` mutation with the same inputs.
    throw new Error(userErrors.map((error) => error.message ?? "Unknown error").join("; "));
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 6 — Impact Checker
 * ──────────────────────────────────────────────────────────────────────────── */

const IMPACT_SAMPLE_LIMIT = 5;
const IMPACT_ORDER_COUNT = 100;

export function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export const COMMON_COUNTRY_CODES: Record<string, string> = {
  "costa rica": "CR",
  "costarrica": "CR",
  "kazakhstan": "KZ",
  "казахстан": "KZ",
  "qazaqstan": "KZ",
  "united states": "US",
  "usa": "US",
  "canada": "CA",
  "united kingdom": "GB",
  "uk": "GB",
  "great britain": "GB",
  "mexico": "MX",
  "méxico": "MX",
  "spain": "ES",
  "españa": "ES",
  "russia": "RU",
  "россия": "RU",
  "germany": "DE",
  "france": "FR",
  "china": "CN",
  "japan": "JP",
  "australia": "AU",
  "brazil": "BR",
  "brasil": "BR",
  "nigeria": "NG",
  "india": "IN",
};

export function normalizeCountry(val: unknown): string {
  const raw = String(val ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.length === 2) return raw.toUpperCase();
  const stripped = stripDiacritics(raw);
  return COMMON_COUNTRY_CODES[stripped] || COMMON_COUNTRY_CODES[raw] || raw.toUpperCase();
}

/** Mirrors run.ts ordering: VIP bypass → quantity → regex → geo → mismatch. */
export function simulateOrders(
  orders: unknown[],
  rules: ParsedRules,
  settings?: CartGuardSettings,
): ImpactResult {
  let blocked = 0;
  const samples: string[] = [];

  // If settings not provided, default all to true for full simulation
  const effectiveSettings: CartGuardSettings = settings ?? {
    enable_vip: true,
    enable_po_box: true,
    enable_quantity: true,
    enable_geo: true,
    enable_mismatch: true,
  };

  const normalizeText = (value: unknown): string =>
    stripDiacritics(String(value ?? "").trim().toLowerCase()).replace(/\s+/g, " ");
  const normalizeZip = (value: unknown): string =>
    String(value ?? "").replace(/\s+/g, "").toLowerCase();

  // Pre-compile regex rules safely with unicode support and optional country/city scoping
  const compiledRegexRules: Array<{
    pattern: string;
    regex: RegExp;
    country?: string;
    city?: string;
  }> = [];
  for (const rule of rules.regexRules) {
    if (typeof rule?.pattern === "string" && rule.pattern.trim()) {
      try {
        let rx: RegExp;
        try {
          rx = new RegExp(rule.pattern, "iu");
        } catch {
          rx = new RegExp(rule.pattern, "i");
        }
        compiledRegexRules.push({
          pattern: rule.pattern,
          regex: rx,
          country: rule.country ? normalizeCountry(rule.country) : undefined,
          city: rule.city ? normalizeText(rule.city) : undefined,
        });
      } catch {
        // Skip invalid regex (fail-open)
      }
    }
  }

  const blockedZips = new Set(rules.geoBlocklist.zips.map(normalizeZip).filter(Boolean));
  const blockedCities = new Set(rules.geoBlocklist.cities.map(normalizeText).filter(Boolean));
  const blockedStates = new Set(rules.geoBlocklist.states.map(normalizeText).filter(Boolean));
  const blockedCountries = new Set(rules.geoBlocklist.countries.map(normalizeCountry).filter(Boolean));

  // Normalized VIP entries (emails and street addresses)
  const normalizedVipEmails = new Set<string>();
  const normalizedVipAddresses = new Set<string>();
  for (const entry of rules.vipAllowlist) {
    const norm = normalizeText(entry);
    if (!norm) continue;
    if (norm.includes("@")) {
      normalizedVipEmails.add(norm);
    } else if (norm.length >= 6) {
      // Must be a substantial address, not just "Apt 1" or "Suite 2"
      normalizedVipAddresses.add(norm);
    }
  }

  for (const order of orders) {
    const typed = order as {
      id?: string;
      name?: string;
      email?: string | null;
      customer?: { emailAddress?: { emailAddress?: string | null } | null } | null;
      shippingAddress?: {
        address1?: string | null;
        address2?: string | null;
        city?: string | null;
        provinceCode?: string | null;
        zip?: string | null;
        countryCode?: string | null;
      } | null;
      billingAddress?: {
        address1?: string | null;
        city?: string | null;
        provinceCode?: string | null;
        zip?: string | null;
        countryCode?: string | null;
      } | null;
      lineItems?: { nodes?: Array<{ quantity?: number | null; variant?: { product?: { id?: string | null; tags?: string[] | null } | null } | null }> | null } | null;
    };

    let label = typed?.name ?? typed?.id ?? "Order";
    if (label.startsWith("gid://shopify/Order/")) {
      label = `Order #${label.split("/").pop()}`;
    }

    const email = normalizeText(typed?.email ?? typed?.customer?.emailAddress?.emailAddress);
    const shipping = typed?.shippingAddress;
    const address1 = normalizeText(shipping?.address1);
    const shippingCountry = normalizeCountry(shipping?.countryCode);
    const shippingCity = normalizeText(shipping?.city);
    const shippingZip = normalizeZip(shipping?.zip);
    const shippingState = normalizeText(shipping?.provinceCode);

    // 1) VIP allowlist check — VIP bypasses EVERYTHING unconditionally!
    // Any buyer on the VIP allowlist (by email or address) bypasses all restrictions,
    // geographic blocks, quantity limits, and mismatches.
    const isVip = Boolean(
      effectiveSettings.enable_vip &&
      ((email && normalizedVipEmails.has(email)) ||
        (address1 && normalizedVipAddresses.has(address1)))
    );

    if (isVip) {
      continue;
    }

    const reasons: string[] = [];

    // 2) Bulk quantity limits.
    if (effectiveSettings.enable_quantity) {
      const perProduct = new Map<string, { quantity: number; tags: Set<string> }>();
      for (const line of typed?.lineItems?.nodes ?? []) {
        const product = line?.variant?.product;
        const productId = product?.id;
        if (!productId) continue;
        const aggregate = perProduct.get(productId) ?? { quantity: 0, tags: new Set<string>() };
        aggregate.quantity += Number(line?.quantity ?? 0);
        for (const tag of product?.tags ?? []) {
          if (typeof tag === "string" && tag) aggregate.tags.add(tag);
        }
        perProduct.set(productId, aggregate);
      }
      for (const [prodId, aggregate] of perProduct) {
        for (const [key, limit] of Object.entries(rules.quantityLimits)) {
          const max = typeof limit === "number" ? limit : limit.max;
          const matches = key === "all" || key === "*" || prodId.includes(key) || aggregate.tags.has(key);
          if (matches && aggregate.quantity > max) {
            reasons.push(`${aggregate.quantity} units exceed limit of ${max} for "${key}"`);
          }
        }
      }
    }

    if (shipping) {
      const rawAddress1 = String(shipping.address1 ?? "").trim();
      const rawAddress2 = String(shipping.address2 ?? "").trim();
      const combinedAddress = `${rawAddress1} ${rawAddress2} ${shipping.city ?? ""} ${shipping.provinceCode ?? ""} ${shipping.zip ?? ""} ${shipping.countryCode ?? ""}`.trim();

      // 3) Address / street / PO Box regex matching (with country/city scoping)
      let matchedRulePattern = "";
      if (effectiveSettings.enable_po_box) {
        for (const item of compiledRegexRules) {
          // If the rule is scoped to a country (e.g. "CR" for Costa Rica), verify country
          if (item.country && shippingCountry && item.country !== shippingCountry) {
            continue;
          }
          // If the rule is scoped to a city, verify city
          if (item.city && shippingCity && !shippingCity.includes(item.city)) {
            continue;
          }

          // Test against address1, address2, and full combined address
          if (
            item.regex.test(rawAddress1) ||
            item.regex.test(rawAddress2) ||
            item.regex.test(combinedAddress)
          ) {
            matchedRulePattern = item.pattern;
            reasons.push(`address matched pattern "${item.pattern}"`);
            break;
          }
        }
      }

      // 4) Geographic blocklists (countries, zips, cities, states).
      if (effectiveSettings.enable_geo) {
        if (shippingCountry && blockedCountries.has(shippingCountry)) {
          reasons.push(`country "${shipping.countryCode}" is blocklisted`);
        } else if (shippingZip && blockedZips.has(shippingZip)) {
          reasons.push(`ZIP ${shipping.zip} is blocklisted`);
        } else if (shippingCity && blockedCities.has(shippingCity)) {
          reasons.push(`city "${shipping.city}" is blocklisted`);
        } else if (shippingState && blockedStates.has(shippingState)) {
          reasons.push(`state/province "${shipping.provinceCode}" is blocklisted`);
        }
      }

      // 5) Smart mismatch — full simulation.
      if (effectiveSettings.enable_mismatch) {
        const billing = typed?.billingAddress;
        if (billing) {
          const billingCountry = normalizeCountry(billing.countryCode);
          const isHighRisk = Boolean(matchedRulePattern);
          const isCrossBorderMismatch = Boolean(shippingCountry && billingCountry && shippingCountry !== billingCountry);
          const isStreetOrZipMismatch =
            normalizeText(billing.address1) !== address1 ||
            normalizeZip(billing.zip) !== shippingZip;

          if ((isHighRisk && isStreetOrZipMismatch) || (isCrossBorderMismatch && isStreetOrZipMismatch)) {
            reasons.push("billing/shipping mismatch with high risk or cross-border address");
          }
        }
      }
    }

    if (reasons.length > 0) {
      blocked += 1;
      if (samples.length < IMPACT_SAMPLE_LIMIT) {
        samples.push(`${label} — ${reasons.slice(0, 2).join("; ")}`);
      }
    }
  }

  return { scanned: orders.length, blocked, samples };
}

export async function simulateImpact(
  admin: AdminApi,
  rules: ParsedRules,
  settings?: CartGuardSettings,
): Promise<ImpactResult> {
  const response = await admin.graphql(LAST_ORDERS_QUERY, {
    variables: { first: IMPACT_ORDER_COUNT },
  });
  const body = (await response.json()) as {
    data?: { orders?: { nodes?: unknown[] } };
  };
  const orders = body?.data?.orders?.nodes ?? [];
  return simulateOrders(orders, rules, settings);
}
