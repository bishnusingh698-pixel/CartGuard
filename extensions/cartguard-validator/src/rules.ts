/**
 * CartGuard rule engine.
 *
 * Shared by the checkout Function (src/run.ts) and the admin Impact Checker
 * (app/lib/cartguard.server.ts) so both always evaluate rules identically.
 * Pure TypeScript: no imports and no I/O, so it runs the same in the Shopify
 * Functions (Javy) runtime and in Node.
 *
 * Evaluation order:
 *   1. Blocked countries (hard embargo). Never bypassed, not even by VIPs.
 *   2. VIP allowlist. A signed-in customer whose account email is listed
 *      skips every remaining rule. Emails typed by guests are unverified and
 *      never grant VIP status. A listed street address only exempts delivery
 *      address line 1 from the address rules (step 4); it never skips
 *      quantity limits or geographic blocks.
 *   3. Quantity limits per product (by product tag, product ID or "all").
 *   4. Address rules (PO Box, freight forwarders, military, keywords, streets).
 *   5. ZIP / city / state-province blocklists. Entries can be limited to one
 *      country: "US:90210", "US:Austin", "US-WA".
 *
 * Hardening: address text is canonicalized before matching (NFKC folding,
 * invisible characters removed, accents stripped, length capped) so tricks
 * such as zero-width spaces or full-width letters don't slip through.
 *
 * Fail-open: malformed config disables only the affected rule, invalid regex
 * patterns are skipped, and unexpected errors produce no violations.
 */

export const FEATURE_FLAGS = ["enable_vip", "enable_po_box", "enable_quantity", "enable_geo"] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export type CartGuardSettings = Record<FeatureFlag, boolean>;

export type RegexRule = {
  pattern: string;
  message?: string;
  /** ISO 3166-1 alpha-2 code. When set, the rule only applies in that country. */
  country?: string;
  /** When set, the rule only applies when the delivery city contains this text. */
  city?: string;
  /** Set by the visual editor so its state can be restored from saved rules. */
  preset?: string;
  keywords?: string[];
  street?: string;
};

export type QuantityLimit = { max: number; message?: string };

export type GeoBlocklist = {
  countries: string[];
  zips: string[];
  cities: string[];
  states: string[];
};

export type RuleConfig = {
  settings: CartGuardSettings;
  regexRules: RegexRule[];
  quantityLimits: Record<string, QuantityLimit>;
  geoBlocklist: GeoBlocklist;
  vipAllowlist: string[];
};

/** Raw metafield values (stringified JSON), keyed by metafield key. */
export type RawConfig = {
  settings?: string | null;
  regex_rules?: string | null;
  quantity_limits?: string | null;
  geo_blocklist?: string | null;
  vip_allowlist?: string | null;
};

export type CartAddress = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  countryCode?: string | null;
};

export type CartLineInput = {
  /** Position of the line in the original cart (used for error targets). */
  index: number;
  productId: string;
  quantity: number;
  /** Product tags that are relevant to the configured quantity limits. */
  tags: string[];
};

export type CartInput = {
  /** Email typed at checkout. Unverified, so it never grants VIP status. */
  email?: string | null;
  /** Email of the signed-in customer account (verified by Shopify). */
  customerEmail?: string | null;
  lines: CartLineInput[];
  addresses: Array<{ groupIndex: number; address: CartAddress }>;
};

export type ViolationRule = "country" | "quantity" | "address" | "zip" | "city" | "state";

export type Violation = {
  rule: ViolationRule;
  /** Buyer-facing message. */
  message: string;
  /** JSONPath into the Function input. */
  target: string;
  /** Merchant-facing explanation (Impact Checker samples). */
  detail: string;
};

export const MAX_REGEX_RULES = 50;
export const MAX_PATTERN_LENGTH = 500;
export const MAX_LIMIT_TAGS = 50;
export const MIN_VIP_ADDRESS_LENGTH = 6;
/** Cap on address field length so hostile input can't exhaust the Function's instruction budget. */
const MAX_FIELD_LENGTH = 512;
export const PRODUCT_GID_PREFIX = "gid://shopify/Product/";

export const DEFAULT_ADDRESS_MESSAGE =
  "We can't deliver to this address. Please enter a different delivery address or contact us for help.";
export const DEFAULT_GEO_MESSAGE =
  "We can't deliver to this area. Please choose a different delivery address or contact us for help.";

export const ADDRESS_PRESETS = {
  po_box: {
    label: "PO Box rule",
    pattern:
      "\\bp\\.?\\s*[o0]\\.?\\s*b[o0]x\\b|\\bp\\.?\\s*o\\.?\\s*b\\.?\\s*\\d|\\bpost\\s+office\\s+box\\b|\\bpostal\\s+box\\b|\\bapartado\\s+postal\\b|\\bcasilla\\s+postal\\b|\\bpostfach\\b",
    message: "We can't ship to PO Boxes. Please enter a street address.",
    country: undefined as string | undefined,
  },
  freight: {
    label: "freight forwarder rule",
    pattern:
      "\\bfreight\\s+forward(er|ers|ing)\\b|\\bforwarding\\s+(company|agent|service|address)\\b|\\bpackage\\s+forward(er|ing)\\b|\\breship(per|pers|ping)?\\b|\\btransshipment\\b",
    message: "We don't ship to freight forwarders or reshipping services.",
    country: undefined as string | undefined,
  },
  military: {
    label: "military address rule",
    pattern: "\\b(apo|fpo|dpo)\\b",
    message: "We can't deliver to military addresses (APO/FPO/DPO).",
    country: "US" as string | undefined,
  },
};
export type AddressPreset = keyof typeof ADDRESS_PRESETS;

/* ── Generic helpers ─────────────────────────────────────────────────────── */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
  }
  return out;
}

function clean(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function stripDiacritics(text: string): string {
  try {
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    return text;
  }
}

export function normalizeText(value: unknown): string {
  return stripDiacritics(clean(value).toLowerCase()).replace(/\s+/g, " ");
}

/** Zero-width, bidi-control and other invisible characters used to break up words. */
const INVISIBLE_CHARS = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g;

function foldCompatibility(text: string): string {
  try {
    return text.normalize("NFKC");
  } catch {
    return text;
  }
}

/**
 * Canonical form used for address matching: compatibility-folded (full-width
 * letters, ligatures), invisible characters removed, accents stripped,
 * whitespace collapsed and length capped. Case is preserved (regexes use "i").
 */
export function normalizeForMatch(value: unknown): string {
  const text = foldCompatibility(clean(value).slice(0, MAX_FIELD_LENGTH)).replace(INVISIBLE_CHARS, "");
  return stripDiacritics(text).replace(/\s+/g, " ").trim();
}

/** Same canonicalization for merchant patterns, so accented keywords still match. */
function normalizePattern(pattern: string): string {
  return stripDiacritics(foldCompatibility(pattern).replace(INVISIBLE_CHARS, ""));
}

/** Spaces and dashes are ignored: "90 210" = "90210", "100-0001" = "1000001". */
export function normalizeZip(value: unknown): string {
  return normalizeForMatch(value).replace(/[\s\-\u2010-\u2015]+/g, "").toLowerCase();
}

/** City comparison ignores case, accents and punctuation ("St. John's" = "st johns"). */
export function normalizeCity(value: unknown): string {
  return normalizeForMatch(value)
    .toLowerCase()
    .replace(/['\u2019`\u00b4]/g, "")
    .replace(/[.,"\-_/\\()#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "US-CA" and "CA" both normalize to "ca". */
export function normalizeState(value: unknown): string {
  return normalizeText(value).replace(/^[a-z]{2}[-:]/, "");
}

const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US", "united states of america": "US", usa: "US", "u.s.a.": "US", america: "US",
  canada: "CA", mexico: "MX", "costa rica": "CR", costarrica: "CR", panama: "PA", guatemala: "GT",
  honduras: "HN", "el salvador": "SV", nicaragua: "NI", colombia: "CO", venezuela: "VE", brazil: "BR",
  brasil: "BR", argentina: "AR", chile: "CL", peru: "PE", ecuador: "EC", bolivia: "BO", paraguay: "PY",
  uruguay: "UY", cuba: "CU", "dominican republic": "DO", haiti: "HT", jamaica: "JM", "puerto rico": "PR",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB", ireland: "IE", france: "FR",
  germany: "DE", deutschland: "DE", spain: "ES", espana: "ES", portugal: "PT", italy: "IT", italia: "IT",
  netherlands: "NL", "the netherlands": "NL", holland: "NL", belgium: "BE", switzerland: "CH",
  austria: "AT", poland: "PL", sweden: "SE", norway: "NO", denmark: "DK", finland: "FI", greece: "GR",
  turkey: "TR", turkiye: "TR", ukraine: "UA", belarus: "BY", russia: "RU", "russian federation": "RU",
  "россия": "RU", kazakhstan: "KZ", qazaqstan: "KZ", "казахстан": "KZ", uzbekistan: "UZ",
  kyrgyzstan: "KG", tajikistan: "TJ", turkmenistan: "TM", armenia: "AM", azerbaijan: "AZ", china: "CN",
  japan: "JP", "south korea": "KR", korea: "KR", "north korea": "KP", india: "IN", pakistan: "PK",
  bangladesh: "BD", indonesia: "ID", philippines: "PH", vietnam: "VN", "viet nam": "VN", thailand: "TH",
  malaysia: "MY", singapore: "SG", "hong kong": "HK", taiwan: "TW", australia: "AU", "new zealand": "NZ",
  kiribati: "KI", fiji: "FJ", iran: "IR", iraq: "IQ", syria: "SY", israel: "IL", "saudi arabia": "SA",
  "united arab emirates": "AE", uae: "AE", egypt: "EG", nigeria: "NG", ghana: "GH", kenya: "KE",
  "south africa": "ZA", morocco: "MA", ethiopia: "ET",
};

/** Returns an ISO alpha-2 code, or null when the value can't be resolved. */
export function resolveCountryCode(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  const named = COUNTRY_NAMES[lowered] ?? COUNTRY_NAMES[stripDiacritics(lowered)];
  if (named) return named;
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return null;
}

export function normalizeCountry(value: unknown): string {
  return resolveCountryCode(value) ?? clean(value).toUpperCase();
}

/**
 * Splits an optional country prefix off a blocklist entry: "US:90210",
 * "US:Austin" and (for states, allowDash) "US-WA" / "JP-13".
 */
export function splitCountryScope(entry: string, allowDash: boolean): { country?: string; value: string } {
  const pattern = allowDash ? /^\s*([a-z]{2})\s*[:-]\s*(.+)$/i : /^\s*([a-z]{2})\s*:\s*(.+)$/i;
  const match = pattern.exec(entry);
  if (!match) return { value: entry };
  return { country: resolveCountryCode(match[1]) ?? match[1].toUpperCase(), value: match[2] };
}

export function compileRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return null;
  try {
    return new RegExp(pattern, "iu");
  } catch {
    try {
      return new RegExp(pattern, "i");
    } catch {
      return null;
    }
  }
}

/**
 * Heuristic ReDoS guard: flags back-references and quantified groups that
 * themselves contain a quantifier, e.g. (a+)+ or (\w+\s?)*. Such patterns can
 * take exponential time and stall checkout or the admin server.
 */
export function isRiskyPattern(pattern: string): boolean {
  if (/\\[1-9]|\\k</.test(pattern)) return true;
  // Quantified group that itself contains a quantifier: (a+)+, (\w+\s?)*
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/.test(pattern)) return true;
  // Quantified group with alternation: (a|a)*, (a|ab)+. Overlapping branches
  // backtrack exponentially and would block the Node event loop during the
  // Impact Checker, stalling the server for every shop.
  return /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/.test(pattern);
}

/* ── Config parsing (tolerant) ───────────────────────────────────────────── */

export function parseSettings(raw: unknown): CartGuardSettings {
  const parsed = parseJson(raw);
  const settings = {} as CartGuardSettings;
  for (const flag of FEATURE_FLAGS) {
    settings[flag] = isRecord(parsed) && parsed[flag] === true;
  }
  return settings;
}

export function parseRegexRules(raw: unknown): RegexRule[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const rules: RegexRule[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const pattern = typeof entry.pattern === "string" ? entry.pattern.trim() : "";
    if (!pattern) continue;
    const rule: RegexRule = { pattern };
    if (typeof entry.message === "string" && entry.message.trim()) rule.message = entry.message.trim();
    if (typeof entry.country === "string" && entry.country.trim()) rule.country = entry.country.trim();
    if (typeof entry.city === "string" && entry.city.trim()) rule.city = entry.city.trim();
    if (typeof entry.preset === "string" && entry.preset.trim()) rule.preset = entry.preset.trim();
    const keywords = toStringList(entry.keywords);
    if (keywords.length > 0) rule.keywords = keywords;
    if (typeof entry.street === "string" && entry.street.trim()) rule.street = entry.street.trim();
    rules.push(rule);
  }
  return rules;
}

export function parseQuantityLimits(raw: unknown): Record<string, QuantityLimit> {
  const parsed = parseJson(raw);
  const limits: Record<string, QuantityLimit> = {};
  if (!isRecord(parsed)) return limits;
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = rawKey.trim();
    if (!key) continue;
    let max = Number.NaN;
    let message: string | undefined;
    if (typeof value === "number") {
      max = value;
    } else if (isRecord(value)) {
      max = Number(value.max);
      if (typeof value.message === "string" && value.message.trim()) message = value.message.trim();
    }
    if (!Number.isFinite(max)) continue;
    max = Math.floor(max);
    if (max < 1) continue;
    limits[key] = message ? { max, message } : { max };
  }
  return limits;
}

export function parseGeoBlocklist(raw: unknown): GeoBlocklist {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return { countries: [], zips: [], cities: [], states: [] };
  return {
    countries: toStringList(parsed.countries),
    zips: toStringList(parsed.zips),
    cities: toStringList(parsed.cities),
    states: toStringList(parsed.states),
  };
}

export function parseVipAllowlist(raw: unknown): string[] {
  return toStringList(parseJson(raw));
}

export function parseConfig(raw: RawConfig): RuleConfig {
  return {
    settings: parseSettings(raw.settings),
    regexRules: parseRegexRules(raw.regex_rules),
    quantityLimits: parseQuantityLimits(raw.quantity_limits),
    geoBlocklist: parseGeoBlocklist(raw.geo_blocklist),
    vipAllowlist: parseVipAllowlist(raw.vip_allowlist),
  };
}

/* ── Quantity limit keys ─────────────────────────────────────────────────── */

function isGlobalKey(key: string): boolean {
  return key === "*" || key.toLowerCase() === "all";
}

/**
 * Tags the checkout Function must ask Shopify about (via product.hasTags).
 * Product GIDs and the global keys are excluded; numeric keys are kept because
 * they may be tags as well as product IDs.
 */
export function collectLimitTags(limits: Record<string, QuantityLimit>): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(limits)) {
    if (isGlobalKey(key) || key.startsWith(PRODUCT_GID_PREFIX)) continue;
    const lowered = key.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    tags.push(key);
    if (tags.length >= MAX_LIMIT_TAGS) break;
  }
  return tags;
}

function limitMatches(key: string, productId: string, tags: Set<string>): boolean {
  if (isGlobalKey(key)) return true;
  if (key.startsWith(PRODUCT_GID_PREFIX)) return productId === key;
  if (/^\d+$/.test(key) && productId === PRODUCT_GID_PREFIX + key) return true;
  return tags.has(key.toLowerCase());
}

function describeLimitKey(key: string): string {
  if (isGlobalKey(key)) return "all products";
  if (key.startsWith(PRODUCT_GID_PREFIX)) return `product ${key.slice(PRODUCT_GID_PREFIX.length)}`;
  return `tag "${key}"`;
}

/* ── Rules ───────────────────────────────────────────────────────────────── */

function addressTarget(groupIndex: number, field: string): string {
  return `$.cart.deliveryGroups[${groupIndex}].deliveryAddress.${field}`;
}

function blockedCountrySet(geo: GeoBlocklist): Set<string> {
  return new Set(geo.countries.map(normalizeCountry).filter(Boolean));
}

function evaluateBlockedCountries(cart: CartInput, geo: GeoBlocklist): Violation[] {
  const blocked = blockedCountrySet(geo);
  if (blocked.size === 0) return [];
  const violations: Violation[] = [];
  for (const { groupIndex, address } of cart.addresses) {
    const country = normalizeCountry(address.countryCode);
    if (country && blocked.has(country)) {
      violations.push({
        rule: "country",
        message: DEFAULT_GEO_MESSAGE,
        target: addressTarget(groupIndex, "countryCode"),
        detail: `country ${country} is blocked`,
      });
    }
  }
  return violations;
}

type VipLists = { emails: Set<string>; addresses: Set<string> };

const emptyVipLists = (): VipLists => ({ emails: new Set<string>(), addresses: new Set<string>() });

function normalizeVipAddress(value: unknown): string {
  return normalizeForMatch(value).toLowerCase();
}

function buildVipLists(allowlist: string[]): VipLists {
  const lists = emptyVipLists();
  for (const entry of allowlist) {
    const normalized = normalizeText(entry);
    if (!normalized) continue;
    if (normalized.includes("@")) {
      lists.emails.add(normalized);
    } else {
      const address = normalizeVipAddress(entry);
      if (address.length >= MIN_VIP_ADDRESS_LENGTH) lists.addresses.add(address);
    }
  }
  return lists;
}

/** Only the signed-in customer's account email counts; typed guest emails are ignored. */
function isVipCustomer(cart: CartInput, vip: VipLists): boolean {
  if (vip.emails.size === 0) return false;
  const email = normalizeText(cart.customerEmail);
  return Boolean(email) && vip.emails.has(email);
}

function evaluateQuantityLimits(cart: CartInput, limits: Record<string, QuantityLimit>): Violation[] {
  const entries = Object.entries(limits);
  if (entries.length === 0) return [];

  // A product can appear on several lines (one per variant): aggregate them.
  const products = new Map<string, { quantity: number; tags: Set<string>; firstIndex: number }>();
  for (const line of cart.lines) {
    if (!line.productId) continue;
    const quantity = Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    const aggregate = products.get(line.productId) ?? {
      quantity: 0,
      tags: new Set<string>(),
      firstIndex: line.index,
    };
    aggregate.quantity += quantity;
    for (const tag of line.tags) aggregate.tags.add(tag.trim().toLowerCase());
    products.set(line.productId, aggregate);
  }

  const violations: Violation[] = [];
  for (const [productId, aggregate] of products) {
    // The strictest applicable limit wins, so one product yields one error.
    let applied: { key: string; limit: QuantityLimit } | null = null;
    for (const [key, limit] of entries) {
      if (!limitMatches(key, productId, aggregate.tags)) continue;
      if (!applied || limit.max < applied.limit.max) applied = { key, limit };
    }
    if (applied && aggregate.quantity > applied.limit.max) {
      violations.push({
        rule: "quantity",
        message:
          applied.limit.message ||
          `You can buy up to ${applied.limit.max} of this item per order. Please reduce the quantity.`,
        target: `$.cart.lines[${aggregate.firstIndex}].quantity`,
        detail: `${aggregate.quantity} units exceed the limit of ${applied.limit.max} for ${describeLimitKey(applied.key)}`,
      });
    }
  }
  return violations;
}

type CompiledAddressRule = {
  regex: RegExp;
  country?: string;
  city?: string;
  message: string;
  label: string;
};

function describeRule(rule: RegexRule): string {
  if (rule.preset && rule.preset in ADDRESS_PRESETS) {
    return ADDRESS_PRESETS[rule.preset as AddressPreset].label;
  }
  if (rule.preset === "keywords") return "blocked keyword rule";
  if (rule.preset === "street") return `blocked street "${rule.street ?? rule.pattern}"`;
  return `pattern "${rule.pattern}"`;
}

function compileAddressRules(rules: RegexRule[]): CompiledAddressRule[] {
  const compiled: CompiledAddressRule[] = [];
  for (const rule of rules.slice(0, MAX_REGEX_RULES)) {
    const regex = compileRegex(normalizePattern(rule.pattern));
    if (!regex) continue;
    const city = rule.city ? normalizeCity(rule.city) : "";
    compiled.push({
      regex,
      country: rule.country ? normalizeCountry(rule.country) : undefined,
      city: city || undefined,
      message: rule.message || DEFAULT_ADDRESS_MESSAGE,
      label: describeRule(rule),
    });
  }
  return compiled;
}

type AddressField = "address1" | "address2" | "city";

function evaluateAddressRules(cart: CartInput, rules: RegexRule[], vipAddresses: Set<string>): Violation[] {
  const compiled = compileAddressRules(rules);
  if (compiled.length === 0) return [];

  const violations: Violation[] = [];
  for (const { groupIndex, address } of cart.addresses) {
    const line1 = normalizeForMatch(address.address1);
    const line2 = normalizeForMatch(address.address2);
    const cityText = normalizeForMatch(address.city);
    // A VIP street address exempts line 1 only; line 2 and the city are still checked.
    const line1Exempt = Boolean(line1) && vipAddresses.has(line1.toLowerCase());

    // Province, ZIP and country codes are deliberately not matched: short
    // patterns like "\bca\b" would otherwise block whole regions by accident.
    const candidates: Array<{ field: AddressField; text: string }> = [];
    if (line1 && !line1Exempt) candidates.push({ field: "address1", text: line1 });
    if (line2) candidates.push({ field: "address2", text: line2 });
    if (cityText) candidates.push({ field: "city", text: cityText });
    // Catches patterns split across both lines ("PO" / "Box 12").
    if (line1 && line2 && !line1Exempt) candidates.push({ field: "address1", text: `${line1} ${line2}` });
    if (candidates.length === 0) continue;

    const country = normalizeCountry(address.countryCode);
    const city = normalizeCity(address.city);

    for (const rule of compiled) {
      // Scoped rules only apply when the scope is known and matches.
      if (rule.country && rule.country !== country) continue;
      if (rule.city && !(city && city.includes(rule.city))) continue;

      const hit = candidates.find((candidate) => rule.regex.test(candidate.text));
      if (!hit) continue;

      violations.push({
        rule: "address",
        message: rule.message,
        target: addressTarget(groupIndex, hit.field),
        detail: `delivery address matched the ${rule.label}`,
      });
      break; // one address error per delivery group is enough
    }
  }
  return violations;
}

/** Blocklist entries, split into "any country" and "CC|value" scoped entries. */
type ScopedSet = { anywhere: Set<string>; scoped: Set<string> };

function buildScopedSet(entries: string[], allowDash: boolean, normalize: (value: string) => string): ScopedSet {
  const set: ScopedSet = { anywhere: new Set<string>(), scoped: new Set<string>() };
  for (const entry of entries) {
    const { country, value } = splitCountryScope(entry, allowDash);
    const normalized = normalize(value);
    if (!normalized) continue;
    if (country) set.scoped.add(`${country}|${normalized}`);
    else set.anywhere.add(normalized);
  }
  return set;
}

function isEmptyScoped(set: ScopedSet): boolean {
  return set.anywhere.size === 0 && set.scoped.size === 0;
}

function scopedHas(set: ScopedSet, country: string, value: string): boolean {
  if (!value) return false;
  return set.anywhere.has(value) || (Boolean(country) && set.scoped.has(`${country}|${value}`));
}

/** A US ZIP+4 ("90210-1234") also matches its 5-digit ZIP. */
function zipCandidates(raw: unknown): string[] {
  const zip = normalizeZip(raw);
  if (!zip) return [];
  const plus4 = /^(\d{5})[\s-]?\d{4}$/.exec(normalizeForMatch(raw));
  return plus4 ? [zip, plus4[1]] : [zip];
}

function evaluateRegionalBlocks(cart: CartInput, geo: GeoBlocklist): Violation[] {
  const zips = buildScopedSet(geo.zips, false, normalizeZip);
  const cities = buildScopedSet(geo.cities, false, normalizeCity);
  const states = buildScopedSet(geo.states, true, normalizeText);
  if (isEmptyScoped(zips) && isEmptyScoped(cities) && isEmptyScoped(states)) return [];
  const blockedCountries = blockedCountrySet(geo);

  const violations: Violation[] = [];
  for (const { groupIndex, address } of cart.addresses) {
    const country = normalizeCountry(address.countryCode);
    // Already reported by the country rule.
    if (country && blockedCountries.has(country)) continue;

    if (zipCandidates(address.zip).some((zip) => scopedHas(zips, country, zip))) {
      violations.push({ rule: "zip", message: DEFAULT_GEO_MESSAGE, target: addressTarget(groupIndex, "zip"), detail: `ZIP/postal code ${clean(address.zip)} is blocked` });
      continue;
    }
    if (scopedHas(cities, country, normalizeCity(address.city))) {
      violations.push({ rule: "city", message: DEFAULT_GEO_MESSAGE, target: addressTarget(groupIndex, "city"), detail: `city "${clean(address.city)}" is blocked` });
      continue;
    }
    const state = normalizeText(splitCountryScope(clean(address.provinceCode), true).value);
    if (scopedHas(states, country, state)) {
      violations.push({ rule: "state", message: DEFAULT_GEO_MESSAGE, target: addressTarget(groupIndex, "provinceCode"), detail: `state/province ${clean(address.provinceCode)} is blocked` });
    }
  }
  return violations;
}

/** Runs every enabled rule against a cart. Never throws. */
export function evaluateCart(cart: CartInput, config: RuleConfig): Violation[] {
  const { settings } = config;
  const violations: Violation[] = [];
  const safely = (step: () => Violation[]) => {
    try {
      violations.push(...step());
    } catch {
      // fail-open: a broken rule never blocks checkout
    }
  };

  // 1) Hard embargo: applies to everyone, VIPs included.
  if (settings.enable_geo) safely(() => evaluateBlockedCountries(cart, config.geoBlocklist));

  // 2) VIP: signed-in listed customers skip the rest; listed addresses are
  //    handled inside the address rules.
  let vip = emptyVipLists();
  if (settings.enable_vip) {
    try {
      vip = buildVipLists(config.vipAllowlist);
      if (isVipCustomer(cart, vip)) return violations;
    } catch {
      vip = emptyVipLists();
    }
  }

  if (settings.enable_quantity) safely(() => evaluateQuantityLimits(cart, config.quantityLimits));
  if (settings.enable_po_box) safely(() => evaluateAddressRules(cart, config.regexRules, vip.addresses));
  if (settings.enable_geo) safely(() => evaluateRegionalBlocks(cart, config.geoBlocklist));

  return violations;
}
