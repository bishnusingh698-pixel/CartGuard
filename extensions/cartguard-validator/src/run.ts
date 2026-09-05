/**
 * CartGuard Validator — Shopify Function entrypoint.
 *
 * Target  : purchase.validation.run
 * API     : 2026-07
 * Runtime : Shopify Functions (WASM, @shopify/shopify_function)
 * Export  : `run` (pinned by [[extensions.targeting]].export)
 * Input   : src/run.graphql — cartguard shop metafields are aliased under
 *           `shop { regex_rules: metafield(...) { value } … }` and granted via
 *           [[extensions.metafields]] in shopify.extension.toml.
 *
 * RULE PIPELINE (evaluation order)
 *   1. VIP Allowlist          — checked FIRST; on match returns immediately
 *                               with zero errors (bypasses every other rule).
 *   2. Bulk Quantity Limiter  — runs on ALL buyerJourney steps.
 *   3. PO Box / Freight       — regex rules on delivery address1/address2,
 *      Forwarder Blocker        gated to buyerJourney.step === CHECKOUT_COMPLETION.
 *   4. Geographic Zone        — zip / city / provinceCode blocklists; evaluates
 *      Blocker                  every delivery group so split shipments cannot
 *                               bypass the rule.
 *   5. Smart Mismatch         — shipping address matches a high-risk pattern AND
 *      Detector                 differs from billing address (when the runtime
 *                               surface exposes cart.billingAddress; null → skip).
 *
 * FAIL-OPEN GUARANTEES (architectural constraint #14)
 *   - The entire run is wrapped in try/catch: any unexpected crash yields ZERO
 *     validation errors and checkout proceeds.
 *   - Each feature is isolated: a malformed metafield skips only that feature
 *     and never discards errors produced by features that evaluated cleanly.
 *   - Invalid regex patterns are skipped individually.
 *   - Missing/unparseable `settings` means "all features disabled" — a freshly
 *     installed app is inert by design until the merchant enables rules.
 *
 * RETURN FORMAT (constraint #12): the direct `{ errors }` shape was attempted
 * first and FAILED to type-check against the 2026-07 FunctionResult contract
 * (src/function-result.ts); the wrapped `operations → validationAdd → errors`
 * shape below is the one that compiles. See the worklog for the test evidence.
 *
 * TYPE SOURCES: `RunInput` is the codegen output for src/run.graphql against
 * input-schema.graphql (generated/api.ts, gitignored); the output contract
 * lives in src/function-result.ts.
 */

import type { RunInputQuery as RunInput } from "../generated/api";
import type { FunctionError, FunctionResult } from "./function-result";

/* ────────────────────────────────────────────────────────────────────────────
 * Metafield contract (namespace: "cartguard", type: single_line_text_field)
 * Every value is stringified JSON.
 * ──────────────────────────────────────────────────────────────────────────── */

const MF_KEYS = {
  REGEX_RULES: "regex_rules",
  QUANTITY_LIMITS: "quantity_limits",
  GEO_BLOCKLIST: "geo_blocklist",
  VIP_ALLOWLIST: "vip_allowlist",
  SETTINGS: "settings",
} as const;

/** Hard cap so a misbehaving config cannot flood the checkout UI. */
const MAX_VALIDATION_ERRORS = 10;

const DEFAULT_ADDRESS_BLOCK_MESSAGE =
  "We are unable to deliver to this address. Please provide an alternative delivery address or contact support.";

const DEFAULT_GEO_BLOCK_MESSAGE =
  "We are unable to deliver to the selected delivery area. Please choose a different delivery address or contact support.";

const MISMATCH_WARNING_MESSAGE =
  "For security, orders where the billing and delivery details differ may require additional verification. Please double-check your addresses or contact support.";

/* ────────────────────────────────────────────────────────────────────────────
 * Parsed configuration shapes (stored as stringified JSON in metafields)
 * ──────────────────────────────────────────────────────────────────────────── */

type CartGuardSettings = {
  enable_vip?: boolean;
  enable_po_box?: boolean;
  enable_quantity?: boolean;
  enable_geo?: boolean;
  enable_mismatch?: boolean;
};

type RegexRule = {
  pattern?: unknown;
  message?: unknown;
};

type GeoBlocklist = {
  zips?: unknown;
  cities?: unknown;
  states?: unknown;
};

/** `{ "tag": max }` per spec; `{ "tag": { max, message } }` tolerated. */
type QuantityLimitValue = number | { max?: unknown; message?: unknown };

/** Constraint #11 error shape — target is a JSONPath into the cart input. */
type ValidationError = FunctionError;

/* ────────────────────────────────────────────────────────────────────────────
 * Structural helpers over the generated input types.
 * NonNullable chains keep this file compiling whether the regenerated
 * generated/api.ts marks these fields nullable or not.
 * ──────────────────────────────────────────────────────────────────────────── */

type Cart = NonNullable<RunInput["cart"]>;
type DeliveryGroup = NonNullable<Cart["deliveryGroups"]>[number];
type CartLine = NonNullable<Cart["lines"]>[number];

type VariantLike = {
  id?: string | null;
  product?: { id?: string | null; tags?: string[] | null } | null;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Safe metafield + JSON access
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Reads a `cartguard` shop metafield through the aliased `shop { … }` fields
 * declared in src/run.graphql (regex_rules, quantity_limits, …). Never throws.
 */
function readMetafield(input: RunInput, key: string): string | null {
  try {
    const shop = input.shop;
    if (!shop) return null;

    let value: string | null | undefined;
    switch (key) {
      case MF_KEYS.REGEX_RULES:
        value = shop.regex_rules?.value;
        break;
      case MF_KEYS.QUANTITY_LIMITS:
        value = shop.quantity_limits?.value;
        break;
      case MF_KEYS.GEO_BLOCKLIST:
        value = shop.geo_blocklist?.value;
        break;
      case MF_KEYS.VIP_ALLOWLIST:
        value = shop.vip_allowlist?.value;
        break;
      case MF_KEYS.SETTINGS:
        value = shop.settings?.value;
        break;
    }
    if (typeof value === "string") return value;
  } catch {
    // fall through — fail-open
  }
  return null;
}

/** JSON.parse that returns null instead of throwing (fail-open). */
function parseJsonSafe<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeZip(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function asTrimmedString(value: unknown): string {
  return String(value ?? "").trim();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 5 — VIP Allowlist (evaluated FIRST)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * True when the buyer email OR a delivery street address appears verbatim
 * (case-insensitive) in the allowlist. Entries may be emails or addresses.
 */
function isAllowlisted(input: RunInput, allowlist: unknown[]): boolean {
  const entries = allowlist
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;

  const email = normalizeText(input.cart?.buyerIdentity?.email);
  if (email && entries.includes(email)) return true;

  const groups = Array.isArray(input.cart?.deliveryGroups) ? input.cart.deliveryGroups : [];
  for (const group of groups) {
    const address1 = normalizeText(group?.deliveryAddress?.address1);
    const address2 = normalizeText(group?.deliveryAddress?.address2);
    if ((address1 && entries.includes(address1)) || (address2 && entries.includes(address2))) {
      return true;
    }
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 2 — Bulk Quantity Limiter (ALL buyerJourney steps)
 * ──────────────────────────────────────────────────────────────────────────── */

function evaluateQuantityLimits(
  input: RunInput,
  limits: Record<string, QuantityLimitValue>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const lines: CartLine[] = Array.isArray(input.cart?.lines) ? input.cart.lines : [];

  // Aggregate quantities per product (a product may appear on several lines)
  // and collect its tag set. quantity_limits is `{ tag: max }`.
  const perProduct = new Map<string, { quantity: number; tags: Set<string> }>();

  for (const line of lines) {
    if (!line || line.merchandise?.__typename !== "ProductVariant") continue;
    const variant = line.merchandise as unknown as VariantLike;
    const productId = String(variant?.product?.id ?? "");
    if (!productId) continue;

    const aggregate = perProduct.get(productId) ?? { quantity: 0, tags: new Set<string>() };
    aggregate.quantity += Number(line.quantity ?? 0);
    for (const tag of variant?.product?.tags ?? []) {
      if (typeof tag === "string" && tag.length > 0) aggregate.tags.add(tag);
    }
    perProduct.set(productId, aggregate);
  }

  for (const [, aggregate] of perProduct) {
    for (const [tag, rawLimit] of Object.entries(limits)) {
      if (!tag || !aggregate.tags.has(tag)) continue;

      const max = typeof rawLimit === "number" ? rawLimit : Number(rawLimit?.max);
      if (!Number.isFinite(max) || max <= 0) continue; // invalid limit → skip (fail-open)

      if (aggregate.quantity > max) {
        const customMessage =
          typeof rawLimit === "object" && rawLimit ? asTrimmedString(rawLimit.message) : "";
        errors.push({
          localizedMessage:
            customMessage ||
            `Quantity limit: a maximum of ${max} unit(s) per order applies to products tagged "${tag}".`,
          target: "$.cart.lines",
        });
      }
    }
  }

  return errors;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 1 — PO Box & Freight Forwarder Blocker (CHECKOUT_COMPLETION only)
 * ──────────────────────────────────────────────────────────────────────────── */

function evaluateRegexRules(deliveryGroups: DeliveryGroup[], rules: RegexRule[]): ValidationError[] {
  const errors: ValidationError[] = [];

  // Pre-compile regexes safely once to avoid instruction and allocation overhead in Wasm
  const compiledRules: Array<{ regex: RegExp; message?: unknown }> = [];
  for (const rule of rules) {
    const pattern = typeof rule?.pattern === "string" ? rule.pattern.trim() : "";
    if (!pattern) continue;
    try {
      compiledRules.push({
        regex: new RegExp(pattern, "i"),
        message: rule.message,
      });
    } catch {
      // Invalid regex -> skip this rule safely (fail-open)
    }
  }

  if (compiledRules.length === 0) return [];

  deliveryGroups.forEach((group, groupIndex) => {
    const address = group?.deliveryAddress;
    if (!address) return;

    for (const line of [address.address1, address.address2]) {
      const text = asTrimmedString(line);
      if (!text) continue;

      for (const compiled of compiledRules) {
        if (compiled.regex.test(text)) {
          errors.push({
            localizedMessage: asTrimmedString(compiled.message) || DEFAULT_ADDRESS_BLOCK_MESSAGE,
            target: `$.cart.deliveryGroups[${groupIndex}].deliveryAddress`,
          });
          break; // first matching rule per address line is enough
        }
      }
    }
  });

  return errors;
}

/** True when any delivery street line matches any configured pattern. */
function matchesHighRiskPattern(
  address1: unknown,
  address2: unknown,
  rules: RegexRule[],
): boolean {
  const compiledRegexes: RegExp[] = [];
  for (const rule of rules) {
    const pattern = typeof rule?.pattern === "string" ? rule.pattern.trim() : "";
    if (!pattern) continue;
    try {
      compiledRegexes.push(new RegExp(pattern, "i"));
    } catch {
      // Skip invalid regex
    }
  }

  if (compiledRegexes.length === 0) return false;

  for (const line of [asTrimmedString(address1), asTrimmedString(address2)]) {
    if (!line) continue;
    for (const regex of compiledRegexes) {
      if (regex.test(line)) return true;
    }
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 3 — Geographic Zone Blocker
 * ──────────────────────────────────────────────────────────────────────────── */

function evaluateGeoBlocklist(
  deliveryGroups: DeliveryGroup[],
  blocklist: GeoBlocklist,
): ValidationError[] {
  const zips = new Set(
    (Array.isArray(blocklist?.zips) ? blocklist.zips : [])
      .map((zip) => normalizeZip(zip))
      .filter((zip) => zip.length > 0),
  );
  const cities = new Set(
    (Array.isArray(blocklist?.cities) ? blocklist.cities : [])
      .map((city) => normalizeText(city))
      .filter((city) => city.length > 0),
  );
  const states = new Set(
    (Array.isArray(blocklist?.states) ? blocklist.states : [])
      .map((state) => normalizeText(state))
      .filter((state) => state.length > 0),
  );

  if (zips.size === 0 && cities.size === 0 && states.size === 0) return [];

  const errors: ValidationError[] = [];

  // Validate every delivery group with accurate target index
  deliveryGroups.forEach((group, groupIndex) => {
    const address = group?.deliveryAddress;
    if (!address) return;

    const zip = normalizeZip(address.zip);
    if (zip && zips.has(zip)) {
      errors.push({
        localizedMessage: DEFAULT_GEO_BLOCK_MESSAGE,
        target: `$.cart.deliveryGroups[${groupIndex}].deliveryAddress`,
      });
      return;
    }

    const city = normalizeText(address.city);
    if (city && cities.has(city)) {
      errors.push({
        localizedMessage: DEFAULT_GEO_BLOCK_MESSAGE,
        target: `$.cart.deliveryGroups[${groupIndex}].deliveryAddress`,
      });
      return;
    }

    const provinceCode = normalizeText(address.provinceCode);
    if (provinceCode && states.has(provinceCode)) {
      errors.push({
        localizedMessage: DEFAULT_GEO_BLOCK_MESSAGE,
        target: `$.cart.deliveryGroups[${groupIndex}].deliveryAddress`,
      });
      return;
    }
  });

  return errors;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 4 — Smart Mismatch Detector
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Fires when BOTH hold:
 *   (a) the shipping street address matches a high-risk pattern (reuses the
 *       `regex_rules` patterns — PO boxes / freight forwarders are exactly the
 *       reroute indicators merchants care about), and
 *   (b) the shipping address differs from the billing address.
 *
 * `cart.billingAddress` is read defensively (constraint: "may be null").
 * If null, the check is skipped (fail-open). The Admin Impact Checker always
 * has real historical billing addresses and simulates this rule fully.
 */
function evaluateMismatch(
  input: RunInput,
  deliveryGroups: DeliveryGroup[],
  rules: RegexRule[],
): string | null {
  // Spec target: $.cart.deliveryGroups[0].deliveryAddress
  const shipping = deliveryGroups[0]?.deliveryAddress;
  if (!shipping) return null;

  if (!matchesHighRiskPattern(shipping.address1, shipping.address2, rules)) return null;

  const billing = input.cart?.billingAddress;
  if (!billing) return null; // billing null → skip this check (fail-open)

  const mismatched =
    normalizeText(billing.address1) !== normalizeText(shipping.address1) ||
    normalizeText(billing.city) !== normalizeText(shipping.city) ||
    normalizeZip(billing.zip) !== normalizeZip(shipping.zip);

  return mismatched ? MISMATCH_WARNING_MESSAGE : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pipeline
 * ──────────────────────────────────────────────────────────────────────────── */

function evaluateAllRules(input: RunInput): ValidationError[] {
  const errors: ValidationError[] = [];

  // Missing/unparseable settings ⇒ every flag stays undefined ⇒ disabled.
  const settings =
    parseJsonSafe<CartGuardSettings>(readMetafield(input, MF_KEYS.SETTINGS)) ?? {};

  // Per-feature isolation: one broken feature must not discard clean results.
  const runFeature = (step: () => ValidationError[]): void => {
    try {
      errors.push(...step());
    } catch {
      // fail-open
    }
  };

  // 1) VIP Allowlist — checked FIRST: on match bypass ALL rules immediately.
  if (settings.enable_vip === true) {
    const allowlist = parseJsonSafe<unknown[]>(readMetafield(input, MF_KEYS.VIP_ALLOWLIST));
    if (Array.isArray(allowlist)) {
      let bypass = false;
      try {
        bypass = isAllowlisted(input, allowlist);
      } catch {
        bypass = false;
      }
      if (bypass) return []; // ← spec: immediate clean result
    }
  }

  // 2) Bulk Quantity Limiter — runs on ALL buyerJourney steps.
  if (settings.enable_quantity === true) {
    const limits = parseJsonSafe<Record<string, QuantityLimitValue>>(
      readMetafield(input, MF_KEYS.QUANTITY_LIMITS),
    );
    if (limits && typeof limits === "object" && !Array.isArray(limits)) {
      runFeature(() => evaluateQuantityLimits(input, limits));
    }
  }

  const deliveryGroups: DeliveryGroup[] = Array.isArray(input.cart?.deliveryGroups)
    ? input.cart.deliveryGroups
    : [];
  const completing = input.buyerJourney?.step === "CHECKOUT_COMPLETION";

  // 3) PO Box & Freight Forwarder Blocker — CHECKOUT_COMPLETION only.
  if (settings.enable_po_box === true && completing) {
    const rules = parseJsonSafe<RegexRule[]>(readMetafield(input, MF_KEYS.REGEX_RULES));
    if (Array.isArray(rules)) {
      runFeature(() => evaluateRegexRules(deliveryGroups, rules));
    }
  }

  // 4) Geographic Zone Blocker.
  if (settings.enable_geo === true) {
    const blocklist = parseJsonSafe<GeoBlocklist>(readMetafield(input, MF_KEYS.GEO_BLOCKLIST));
    if (blocklist && typeof blocklist === "object" && !Array.isArray(blocklist)) {
      runFeature(() => evaluateGeoBlocklist(deliveryGroups, blocklist));
    }
  }

  // 5) Smart Mismatch Detector.
  if (settings.enable_mismatch === true) {
    const rules = parseJsonSafe<RegexRule[]>(readMetafield(input, MF_KEYS.REGEX_RULES));
    if (Array.isArray(rules)) {
      runFeature(() => {
        const message = evaluateMismatch(input, deliveryGroups, rules);
        return message
          ? [{ localizedMessage: message, target: "$.cart.deliveryGroups[0].deliveryAddress" }]
          : [];
      });
    }
  }

  return errors;
}

/** Wraps targeted errors into the purchase.validation Function result shape. */
function toResult(errors: ValidationError[]): FunctionResult {
  // Dedupe by (target, localizedMessage) — identical errors raised against the
  // same input path collapse into one, and the target path is preserved.
  const unique = Array.from(
    new Map(
      errors.map((error) => [`${error.target}|${error.localizedMessage}`, error] as const),
    ).values(),
  ).slice(0, MAX_VALIDATION_ERRORS);

  return {
    operations: [
      {
        validationAdd: {
          errors: unique,
        },
      },
    ],
  };
}

/**
 * Function entrypoint pinned by shopify.extension.toml
 * (`[[extensions.targeting]].export = "run"`). The umbrella try/catch is the
 * final fail-open guarantee: CartGuard must never crash checkout.
 */
export function run(input: RunInput): FunctionResult {
  try {
    return toResult(evaluateAllRules(input));
  } catch {
    return toResult([]);
  }
}

export default run;
