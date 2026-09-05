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

export type ParsedRules = {
  regexRules: Array<{ pattern: string; message?: string }>;
  quantityLimits: Record<string, number | { max: number; message?: string }>;
  geoBlocklist: { zips: string[]; cities: string[]; states: string[] };
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
      const entry = rule as { pattern?: unknown; message?: unknown };
      if (typeof entry?.pattern !== "string" || entry.pattern.trim().length === 0) {
        fieldErrors.regex_rules = `Rule ${index + 1}: "pattern" must be a non-empty string.`;
      } else {
        try {
          new RegExp(entry.pattern, "i");
        } catch (error) {
          fieldErrors.regex_rules = `Rule ${index + 1}: invalid regex — ${(error as Error).message}`;
        }
      }
      if (entry?.message !== undefined && typeof entry.message !== "string") {
        fieldErrors.regex_rules = `Rule ${index + 1}: "message" must be a string.`;
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
      if (!tag.trim()) fieldErrors.quantity_limits = "Tags must be non-empty strings.";
      else if (!Number.isFinite(max) || max <= 0) {
        fieldErrors.quantity_limits = `Tag "${tag}": limit must be a positive number.`;
      }
    }
  }

  const geo = safeJsonParse<{ zips?: unknown; cities?: unknown; states?: unknown }>(
    draft.geo_blocklist.trim() || EMPTY_DEFAULTS.geo_blocklist,
  );
  if (!geo || typeof geo !== "object" || Array.isArray(geo)) {
    fieldErrors.geo_blocklist = 'Expected a JSON object with "zips", "cities", "states" arrays.';
  } else {
    for (const key of ["zips", "cities", "states"] as const) {
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
        regexRules.push({
          pattern: rule.pattern,
          ...(typeof rule.message === "string" && rule.message.trim()
            ? { message: rule.message }
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

  const geoSource = safeJsonParse<{ zips?: unknown; cities?: unknown; states?: unknown }>(
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
        }
        billingAddress {
          address1
          city
          provinceCode
          zip
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

  // Pre-compile regex rules safely to avoid re-instantiation overhead and handle invalid patterns
  const compiledRegexRules: Array<{ pattern: string; regex: RegExp }> = [];
  for (const rule of rules.regexRules) {
    if (typeof rule?.pattern === "string" && rule.pattern.trim()) {
      try {
        compiledRegexRules.push({
          pattern: rule.pattern,
          regex: new RegExp(rule.pattern, "i"),
        });
      } catch {
        // Skip invalid regex (fail-open)
      }
    }
  }

  const matchesAnyRule = (text: string): { matched: boolean; pattern: string } => {
    if (!text) return { matched: false, pattern: "" };
    for (const item of compiledRegexRules) {
      if (item.regex.test(text)) {
        return { matched: true, pattern: item.pattern };
      }
    }
    return { matched: false, pattern: "" };
  };

  const normalizeText = (value: unknown): string =>
    String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const normalizeZip = (value: unknown): string =>
    String(value ?? "").replace(/\s+/g, "").toLowerCase();

  const blockedZips = new Set(rules.geoBlocklist.zips.map(normalizeZip).filter(Boolean));
  const blockedCities = new Set(rules.geoBlocklist.cities.map(normalizeText).filter(Boolean));
  const blockedStates = new Set(rules.geoBlocklist.states.map(normalizeText).filter(Boolean));

  // Normalized VIP entries (emails and street addresses)
  const normalizedVipEntries = new Set(
    rules.vipAllowlist.map(normalizeText).filter((entry) => entry.length > 0),
  );

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
      } | null;
      billingAddress?: {
        address1?: string | null;
        city?: string | null;
        provinceCode?: string | null;
        zip?: string | null;
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
    const address2 = normalizeText(shipping?.address2);

    // 1) VIP allowlist bypass — checked first, identical to the Function (checks email AND address lines)
    if (effectiveSettings.enable_vip && normalizedVipEntries.size > 0) {
      if (
        (email && normalizedVipEntries.has(email)) ||
        (address1 && normalizedVipEntries.has(address1)) ||
        (address2 && normalizedVipEntries.has(address2))
      ) {
        continue;
      }
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
      for (const [, aggregate] of perProduct) {
        for (const [tag, limit] of Object.entries(rules.quantityLimits)) {
          if (!aggregate.tags.has(tag)) continue;
          const max = typeof limit === "number" ? limit : limit.max;
          if (aggregate.quantity > max) {
            reasons.push(`${aggregate.quantity} units tagged "${tag}" exceed the limit of ${max}`);
          }
        }
      }
    }

    if (shipping) {
      const rawAddress1 = String(shipping.address1 ?? "").trim();
      const rawAddress2 = String(shipping.address2 ?? "").trim();

      // 3) PO box / freight forwarder regex (historical orders are past
      //    CHECKOUT_COMPLETION, so the journey gate is satisfied).
      let matchedRulePattern = "";
      if (effectiveSettings.enable_po_box) {
        const match1 = matchesAnyRule(rawAddress1);
        const match2 = matchesAnyRule(rawAddress2);
        if (match1.matched) {
          matchedRulePattern = match1.pattern;
          reasons.push(`address matched pattern "${match1.pattern}"`);
        } else if (match2.matched) {
          matchedRulePattern = match2.pattern;
          reasons.push(`address matched pattern "${match2.pattern}"`);
        }
      }

      // 4) Geographic blocklists.
      if (effectiveSettings.enable_geo) {
        const zip = normalizeZip(shipping.zip);
        const city = normalizeText(shipping.city);
        const state = normalizeText(shipping.provinceCode);
        if (zip && blockedZips.has(zip)) {
          reasons.push(`ZIP ${shipping.zip} is blocklisted`);
        } else if (city && blockedCities.has(city)) {
          reasons.push(`city "${shipping.city}" is blocklisted`);
        } else if (state && blockedStates.has(state)) {
          reasons.push(`state/province "${shipping.provinceCode}" is blocklisted`);
        }
      }

      // 5) Smart mismatch — full simulation (Admin API exposes billing).
      if (effectiveSettings.enable_mismatch) {
        const billing = typed?.billingAddress;
        const isHighRisk =
          Boolean(matchedRulePattern) ||
          matchesAnyRule(rawAddress1).matched ||
          matchesAnyRule(rawAddress2).matched;

        if (isHighRisk && billing) {
          const mismatched =
            normalizeText(billing.address1) !== normalizeText(shipping.address1) ||
            normalizeText(billing.city) !== normalizeText(shipping.city) ||
            normalizeZip(billing.zip) !== normalizeZip(shipping.zip);
          if (mismatched) {
            reasons.push("billing/shipping mismatch with a high-risk address");
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
