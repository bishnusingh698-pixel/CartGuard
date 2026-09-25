/**
 * CartGuard admin settings (Remix + Polaris).
 *
 * - Rules are stored in app-owned shop metafields ($app:cartguard, json).
 * - Saving also makes sure CartGuard's checkout rule (a Shopify Validation
 *   running the cartguard-validator Function) exists and is enabled.
 * - "Check impact" simulates the rules on recent orders with the same rule
 *   engine the checkout Function uses.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Page,
  PageActions,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { errorMessage } from "../lib/admin-api.server";
import {
  type ActionResponse,
  type DraftConfig,
  type ImpactResult,
  effectiveRaw,
  parseDraftConfig,
  readConfiguration,
  saveConfiguration,
  simulateImpact,
  validateDraftConfig,
} from "../lib/cartguard.server";
import { type ValidationStatus, getValidationStatus } from "../lib/validation.server";
import {
  ADDRESS_PRESETS,
  FEATURE_FLAGS,
  parseConfig,
  type CartGuardSettings,
  type RegexRule,
  type RuleConfig,
} from "../../extensions/cartguard-validator/src/rules";

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

/* ── Loader ────────────────────────────────────────────────────────────────── */

type LoaderData = { config: RuleConfig; validation: ValidationStatus; needsMigration: boolean };

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const [stored, validation] = await Promise.all([readConfiguration(admin), getValidationStatus(admin)]);
  // Rules saved by older builds live in the public namespace, which the
  // checkout Function doesn't read. They only take effect after a save.
  const needsMigration = !stored.current && Boolean(stored.legacy);
  return json<LoaderData>({ config: parseConfig(effectiveRaw(stored)), validation, needsMigration });
}

/* ── Action ────────────────────────────────────────────────────────────────── */

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const form = await request.formData();
  const intent = form.get("intent") === "simulate" ? "simulate" : "save";
  const confirmed = form.get("confirmed") === "true";
  const draft: DraftConfig = {
    regex_rules: String(form.get("regex_rules") ?? ""),
    quantity_limits: String(form.get("quantity_limits") ?? ""),
    geo_blocklist: String(form.get("geo_blocklist") ?? ""),
    vip_allowlist: String(form.get("vip_allowlist") ?? ""),
  };
  const settings = {} as CartGuardSettings;
  for (const flag of FEATURE_FLAGS) settings[flag] = form.get(flag) === "true";

  const fieldErrors = validateDraftConfig(draft);
  if (Object.keys(fieldErrors).length > 0) {
    return json<ActionResponse>(
      { ok: false, fieldErrors, message: "Some rules need fixing before they can be saved." },
      { status: 400 },
    );
  }
  const config = parseDraftConfig(draft, settings);

  try {
    if (intent === "simulate") {
      const impact = await simulateImpact(admin, config);
      return json<ActionResponse>({ ok: true, impact });
    }

    let impact: ImpactResult | undefined;
    // The merchant already reviewed the impact when confirming, so skip the
    // (slow) simulation on confirmed saves.
    if (!confirmed) {
      try {
        impact = await simulateImpact(admin, config);
      } catch (error) {
        if (error instanceof Response) throw error;
        return json<ActionResponse>({
          ok: true,
          needsConfirm: true,
          impactError: `We couldn't check these rules against recent orders (${errorMessage(error)}).`,
        });
      }
      if (impact.blocked > 0) {
        return json<ActionResponse>({ ok: true, needsConfirm: true, impact });
      }
    }

    const { validationWarning } = await saveConfiguration(admin, config);
    return json<ActionResponse>({ ok: true, saved: true, impact, validationWarning });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[CartGuard] Settings action failed:", error);
    return json<ActionResponse>(
      { ok: false, message: `CartGuard couldn't complete the request: ${errorMessage(error)}` },
      { status: 500 },
    );
  }
}

/* ── Visual editor state ───────────────────────────────────────────────────── */

type QtyRow = { id: string; key: string; max: string; message?: string };

type VisualState = {
  vip: string;
  poBox: boolean;
  freight: boolean;
  military: boolean;
  keywords: string;
  street: string;
  streetCountry: string;
  countries: string;
  zips: string;
  cities: string;
  states: string;
  qtyRows: QtyRow[];
};

let rowSeq = 0;
const newRow = (key = "", max = "10", message?: string): QtyRow => ({ id: `qty-${++rowSeq}`, key, max, message });

const splitList = (value: string) =>
  value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const KEYWORD_MESSAGE = "Your delivery address contains words we can't ship to. Please use a different address.";
const STREET_MESSAGE = "We can't deliver to this address. Please use a different delivery address.";

function visualFromConfig(config: RuleConfig): { visual: VisualState; customRules: RegexRule[] } {
  const byPreset = (preset: string) => config.regexRules.find((rule) => rule.preset === preset);
  const keywordRule = byPreset("keywords");
  const streetRule = byPreset("street");
  // Rules the visual editor owns. Everything else (JSON-mode rules, unknown
  // presets, duplicates) is kept as-is so switching editors never drops a rule.
  const owned = new Set<RegexRule>(
    [byPreset("po_box"), byPreset("freight"), byPreset("military"), keywordRule, streetRule].filter(
      (rule): rule is RegexRule => Boolean(rule),
    ),
  );
  return {
    visual: {
      vip: config.vipAllowlist.join("\n"),
      poBox: Boolean(byPreset("po_box")),
      freight: Boolean(byPreset("freight")),
      military: Boolean(byPreset("military")),
      keywords: (keywordRule?.keywords ?? []).join(", "),
      street: streetRule?.street ?? "",
      streetCountry: streetRule?.country ?? "",
      countries: config.geoBlocklist.countries.join(", "),
      zips: config.geoBlocklist.zips.join(", "),
      cities: config.geoBlocklist.cities.join(", "),
      states: config.geoBlocklist.states.join(", "),
      qtyRows: Object.entries(config.quantityLimits).map(([key, limit]) => newRow(key, String(limit.max), limit.message)),
    },
    customRules: config.regexRules.filter((rule) => !owned.has(rule)),
  };
}

function rulesFromVisual(visual: VisualState, customRules: RegexRule[]): RegexRule[] {
  const rules: RegexRule[] = [];
  const addPreset = (preset: keyof typeof ADDRESS_PRESETS) => {
    const { pattern, message, country } = ADDRESS_PRESETS[preset];
    rules.push({ preset, pattern, message, ...(country ? { country } : {}) });
  };
  if (visual.poBox) addPreset("po_box");
  if (visual.freight) addPreset("freight");
  if (visual.military) addPreset("military");

  const keywords = splitList(visual.keywords);
  if (keywords.length > 0) {
    rules.push({ preset: "keywords", keywords, pattern: keywords.map(escapeRegex).join("|"), message: KEYWORD_MESSAGE });
  }
  const street = visual.street.trim();
  if (street) {
    const country = visual.streetCountry.trim();
    rules.push({ preset: "street", street, pattern: escapeRegex(street), message: STREET_MESSAGE, ...(country ? { country } : {}) });
  }
  return [...rules, ...customRules];
}

function draftFromVisual(visual: VisualState, customRules: RegexRule[]): DraftConfig {
  const quantity: Record<string, number | { max: number; message: string }> = {};
  for (const row of visual.qtyRows) {
    const key = row.key.trim();
    const max = Number.parseInt(row.max, 10);
    if (!key || !Number.isFinite(max) || max < 1) continue;
    quantity[key] = row.message ? { max, message: row.message } : max;
  }
  return {
    vip_allowlist: JSON.stringify(splitList(visual.vip), null, 2),
    regex_rules: JSON.stringify(rulesFromVisual(visual, customRules), null, 2),
    quantity_limits: JSON.stringify(quantity, null, 2),
    geo_blocklist: JSON.stringify(
      {
        countries: splitList(visual.countries),
        zips: splitList(visual.zips),
        cities: splitList(visual.cities),
        states: splitList(visual.states),
      },
      null,
      2,
    ),
  };
}

function jsonValidationError(value: string, kind: "array" | "object"): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (kind === "array" && !Array.isArray(parsed)) return "Expected a JSON array.";
    if (kind === "object" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
      return "Expected a JSON object.";
    }
    return null;
  } catch (error) {
    return `Invalid JSON: ${(error as Error).message}`;
  }
}

const FIELD_LABELS: Record<string, string> = {
  regex_rules: "Address rules",
  quantity_limits: "Quantity limits",
  geo_blocklist: "Geographic blocklist",
  vip_allowlist: "VIP allowlist",
};

function ValidationStatusBanner({ status }: { status: ValidationStatus }) {
  if (status.state === "active") return null;
  if (status.state === "function_not_deployed") {
    return (
      <Banner tone="critical" title="The CartGuard checkout function isn't deployed">
        <Text as="p">Deploy the app with shopify app deploy, then save your rules to switch CartGuard on at checkout.</Text>
      </Banner>
    );
  }
  if (status.state === "unknown") {
    return (
      <Banner tone="warning" title="Couldn't check whether CartGuard is active at checkout">
        <Text as="p">{status.message ?? "Unknown error."}</Text>
      </Banner>
    );
  }
  return (
    <Banner tone="warning" title="CartGuard isn't active at checkout yet">
      <Text as="p">Save your rules to switch CartGuard on. Until then, no checkout is blocked.</Text>
    </Banner>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function CartGuardSettingsPage() {
  const { config, validation, needsMigration } = useLoaderData<typeof loader>() as unknown as LoaderData;
  const fetcher = useFetcher<ActionResponse>();
  const shopify = useAppBridge();

  const [toggles, setToggles] = useState<CartGuardSettings>(config.settings);
  const [visual, setVisual] = useState<VisualState>(() => visualFromConfig(config).visual);
  const [customRules, setCustomRules] = useState<RegexRule[]>(() => visualFromConfig(config).customRules);
  const [mode, setMode] = useState<"visual" | "json">("visual");
  const [jsonDraft, setJsonDraft] = useState<DraftConfig>(() => {
    const initial = visualFromConfig(config);
    return draftFromVisual(initial.visual, initial.customRules);
  });
  const [modeError, setModeError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResponse | null>(null);

  const patchVisual = (patch: Partial<VisualState>) => setVisual((current) => ({ ...current, ...patch }));
  const setToggle = (flag: keyof CartGuardSettings) => (value: boolean) =>
    setToggles((current) => ({ ...current, [flag]: value }));

  const draft = useMemo<DraftConfig>(
    () => (mode === "visual" ? draftFromVisual(visual, customRules) : jsonDraft),
    [mode, visual, customRules, jsonDraft],
  );

  const jsonErrors = useMemo<Partial<Record<keyof DraftConfig, string | null>>>(
    () =>
      mode === "json"
        ? {
            vip_allowlist: jsonValidationError(jsonDraft.vip_allowlist, "array"),
            regex_rules: jsonValidationError(jsonDraft.regex_rules, "array"),
            quantity_limits: jsonValidationError(jsonDraft.quantity_limits, "object"),
            geo_blocklist: jsonValidationError(jsonDraft.geo_blocklist, "object"),
          }
        : {},
    [mode, jsonDraft],
  );
  const hasJsonErrors = Object.values(jsonErrors).some(Boolean);
  const busy = fetcher.state !== "idle";

  const switchMode = () => {
    if (mode === "visual") {
      setJsonDraft(draftFromVisual(visual, customRules));
      setModeError(null);
      setMode("json");
      return;
    }
    if (hasJsonErrors) {
      setModeError("Fix the JSON errors before switching back to the visual editor.");
      return;
    }
    const parsed = parseConfig({ settings: null, ...jsonDraft });
    const next = visualFromConfig({ ...parsed, settings: toggles });
    setVisual(next.visual);
    setCustomRules(next.customRules);
    setModeError(null);
    setMode("visual");
  };

  const submit = useCallback(
    (intent: "simulate" | "save", confirmed = false) => {
      const payload: Record<string, string> = { intent, confirmed: String(confirmed), ...draft };
      for (const flag of FEATURE_FLAGS) payload[flag] = String(toggles[flag]);
      fetcher.submit(payload, { method: "post" });
    },
    [fetcher, draft, toggles],
  );

  useEffect(() => {
    const data = fetcher.data as ActionResponse | undefined;
    if (!data) return;
    setResult(data);
    if (data.saved) {
      shopify.toast.show(
        data.validationWarning ? "Rules saved. Checkout activation needs attention." : "CartGuard rules saved and active at checkout.",
      );
    }
  }, [fetcher.data, shopify]);

  const impact = result?.impact;
  const blockedPercent = impact && impact.scanned > 0 ? Math.round((impact.blocked / impact.scanned) * 100) : 0;

  const impactSummary = impact ? (
    <BlockStack gap="200">
      <Text as="p" fontWeight="semibold">
        {impact.scanned === 0
          ? "No recent orders were found to check."
          : `These rules would have blocked ${impact.blocked} of your last ${impact.scanned} orders (${blockedPercent}%).`}
      </Text>
      {impact.samples.length > 0 && (
        <List>
          {impact.samples.map((sample, index) => (
            <List.Item key={`${index}-${sample}`}>{sample}</List.Item>
          ))}
        </List>
      )}
      <Text as="p" tone="subdued">
        Based on the first 40 products of each order.
      </Text>
    </BlockStack>
  ) : null;

  const jsonField = (key: keyof DraftConfig, label: string, lines: number) => (
    <TextField
      label={label}
      value={jsonDraft[key]}
      onChange={(value) => setJsonDraft((current) => ({ ...current, [key]: value }))}
      multiline={lines}
      monospaced
      autoComplete="off"
      error={jsonErrors[key] ?? result?.fieldErrors?.[key] ?? undefined}
    />
  );

  return (
    <Page
      title="CartGuard checkout rules"
      subtitle="Block risky or undeliverable orders at checkout with Shopify Functions."
      secondaryActions={[
        { content: mode === "json" ? "Switch to visual editor" : "Edit as JSON", onAction: switchMode },
      ]}
    >
      <Layout>
        {validation.state !== "active" && !result?.saved && (
          <Layout.Section>
            <ValidationStatusBanner status={validation} />
          </Layout.Section>
        )}

        {needsMigration && !result?.saved && (
          <Layout.Section>
            <Banner tone="warning" title="Save once to apply these rules at checkout">
              <Text as="p">
                These rules were saved by an older version of CartGuard and aren't enforced at checkout yet. Review them and click Save rules.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {modeError && (
          <Layout.Section>
            <Banner tone="critical" title="Can't switch editors" onDismiss={() => setModeError(null)}>
              <Text as="p">{modeError}</Text>
            </Banner>
          </Layout.Section>
        )}

        {result?.saved && !result.validationWarning && (
          <Layout.Section>
            <Banner tone="success" title="Rules saved and active at checkout" onDismiss={() => setResult(null)}>
              <Text as="p">CartGuard now checks every cart and checkout with these rules.</Text>
            </Banner>
          </Layout.Section>
        )}

        {result?.saved && result.validationWarning && (
          <Layout.Section>
            <Banner tone="warning" title="Rules saved, but CartGuard couldn't be activated at checkout" onDismiss={() => setResult(null)}>
              <BlockStack gap="200">
                <Text as="p">{result.validationWarning}</Text>
                <Text as="p">Fix the problem above and save again. Until then, checkout isn't protected.</Text>
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}

        {result?.needsConfirm && (
          <Layout.Section>
            <Banner
              tone="warning"
              title="Review the impact before saving"
              action={{ content: busy ? "Saving…" : "Save anyway", onAction: () => { if (!busy) submit("save", true); } }}
              secondaryAction={{ content: "Cancel", onAction: () => setResult(null) }}
              onDismiss={() => setResult(null)}
            >
              {result.impactError ? <Text as="p">{result.impactError}</Text> : impactSummary}
            </Banner>
          </Layout.Section>
        )}

        {result && !result.saved && !result.needsConfirm && result.ok && impact && (
          <Layout.Section>
            <Banner tone={impact.blocked > 0 ? "warning" : "success"} title="Impact check" onDismiss={() => setResult(null)}>
              {impactSummary}
            </Banner>
          </Layout.Section>
        )}

        {result && !result.ok && (
          <Layout.Section>
            <Banner tone="critical" title={result.message ?? "Something went wrong"} onDismiss={() => setResult(null)}>
              {result.fieldErrors && (
                <List>
                  {Object.entries(result.fieldErrors).map(([field, message]) => (
                    <List.Item key={field}>
                      {FIELD_LABELS[field] ?? field}: {message}
                    </List.Item>
                  ))}
                </List>
              )}
            </Banner>
          </Layout.Section>
        )}

        {/* VIP allowlist */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">VIP customer allowlist</Text>
                {toggles.enable_vip && <Badge tone="success">Active</Badge>}
              </InlineStack>
              <Checkbox
                label="Let VIP customers skip CartGuard rules"
                helpText="Signed-in customers whose account email is listed skip every rule except blocked countries."
                checked={toggles.enable_vip}
                onChange={setToggle("enable_vip")}
              />
              {toggles.enable_vip && mode === "visual" && (
                <BlockStack gap="200">
                  <TextField
                    label="VIP emails or street addresses"
                    helpText="One per line or comma-separated. Emails only count when the customer is signed in to their account. A street address must match delivery address line 1 exactly and only exempts that line from the address rules."
                    placeholder={"vip@customer.com\n123 Executive Blvd"}
                    value={visual.vip}
                    onChange={(value) => patchVisual({ vip: value })}
                    multiline={3}
                    autoComplete="off"
                  />
                  <InlineStack gap="200" wrap>
                    {splitList(visual.vip).map((item, index) => (
                      <Tag key={`${index}-${item}`}>{item}</Tag>
                    ))}
                  </InlineStack>
                </BlockStack>
              )}
              {toggles.enable_vip && mode === "json" && jsonField("vip_allowlist", "vip_allowlist (JSON array)", 3)}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Address rules */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">PO Box and freight forwarder blocker</Text>
                {toggles.enable_po_box && <Badge tone="success">Active</Badge>}
              </InlineStack>
              <Checkbox
                label="Check delivery addresses"
                helpText="Blocks checkout when the delivery address matches one of the rules below."
                checked={toggles.enable_po_box}
                onChange={setToggle("enable_po_box")}
              />
              {toggles.enable_po_box && mode === "visual" && (
                <BlockStack gap="300">
                  <Checkbox label="Block PO Boxes (P.O. Box, Post Office Box, Apartado Postal, Postfach)" checked={visual.poBox} onChange={(value) => patchVisual({ poBox: value })} />
                  <Checkbox label="Block freight forwarders and reshippers" checked={visual.freight} onChange={(value) => patchVisual({ freight: value })} />
                  <Checkbox label="Block US military addresses (APO / FPO / DPO)" checked={visual.military} onChange={(value) => patchVisual({ military: value })} />
                  <TextField
                    label="Blocked words or phrases (optional)"
                    helpText="Comma-separated, for example: warehouse 4B, mail drop"
                    value={visual.keywords}
                    onChange={(value) => patchVisual({ keywords: value })}
                    autoComplete="off"
                  />
                  <InlineGrid columns={["twoThirds", "oneThird"]} gap="200">
                    <TextField
                      label="Block a specific street or address (optional)"
                      placeholder="Calle 5, Avenida Central"
                      value={visual.street}
                      onChange={(value) => patchVisual({ street: value })}
                      autoComplete="off"
                    />
                    <TextField
                      label="Only in this country (optional)"
                      helpText="Country name or 2-letter code, e.g. CR. Leave blank to block everywhere."
                      placeholder="CR"
                      value={visual.streetCountry}
                      onChange={(value) => patchVisual({ streetCountry: value })}
                      autoComplete="off"
                    />
                  </InlineGrid>
                  {customRules.length > 0 && (
                    <Text as="p" tone="subdued">
                      {customRules.length} custom rule{customRules.length === 1 ? "" : "s"} added in JSON mode {customRules.length === 1 ? "is" : "are"} also active.
                    </Text>
                  )}
                </BlockStack>
              )}
              {toggles.enable_po_box && mode === "json" && jsonField("regex_rules", "regex_rules (JSON array)", 8)}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Geographic rules */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Geographic blocker</Text>
                {toggles.enable_geo && <Badge tone="success">Active</Badge>}
              </InlineStack>
              <Checkbox
                label="Block deliveries to specific areas"
                checked={toggles.enable_geo}
                onChange={setToggle("enable_geo")}
              />
              {toggles.enable_geo && mode === "visual" && (
                <BlockStack gap="300">
                  <TextField
                    label="Blocked countries"
                    helpText="Comma-separated 2-letter codes or names, e.g. KZ, CR, Kazakhstan. Country blocks apply to VIP customers too."
                    placeholder="KZ, CR"
                    value={visual.countries}
                    onChange={(value) => patchVisual({ countries: value })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Blocked ZIP / postal codes"
                    helpText="Comma-separated, e.g. 10101, 90210. Spaces and dashes are ignored and US ZIP+4 codes match their 5-digit ZIP. Add a country prefix to limit an entry to one country, e.g. US:90210."
                    value={visual.zips}
                    onChange={(value) => patchVisual({ zips: value })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Blocked cities"
                    helpText="Comma-separated, e.g. San José, Tarawa. Accents, capitals and punctuation are ignored. Add a country prefix to limit an entry, e.g. US:Austin."
                    value={visual.cities}
                    onChange={(value) => patchVisual({ cities: value })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Blocked states / provinces"
                    helpText={'Use Shopify province codes with a country prefix, e.g. US-CA, US-NY, CA-ON. Codes without a prefix (WA) apply in every country that uses them. Full names like "California" will not match.'}
                    value={visual.states}
                    onChange={(value) => patchVisual({ states: value })}
                    autoComplete="off"
                  />
                </BlockStack>
              )}
              {toggles.enable_geo && mode === "json" && jsonField("geo_blocklist", "geo_blocklist (JSON object)", 6)}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Quantity limits */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Quantity limits</Text>
                {toggles.enable_quantity && <Badge tone="success">Active</Badge>}
              </InlineStack>
              <Checkbox
                label="Limit units per order by product tag"
                helpText="Stops resellers and bots from buying too many units of a product."
                checked={toggles.enable_quantity}
                onChange={setToggle("enable_quantity")}
              />
              {toggles.enable_quantity && mode === "visual" && (
                <BlockStack gap="300">
                  <Text as="p" tone="subdued">
                    Enter a product tag (or a product ID, or &quot;all&quot; for every product) and the maximum units of each product per order.
                  </Text>
                  {visual.qtyRows.length === 0 && <Text as="p">No limits yet.</Text>}
                  {visual.qtyRows.map((row) => (
                    <InlineGrid columns={["twoThirds", "oneThird"]} gap="200" key={row.id}>
                      <TextField
                        label="Product tag"
                        labelHidden
                        placeholder="e.g. limited-edition"
                        value={row.key}
                        onChange={(value) =>
                          setVisual((current) => ({
                            ...current,
                            qtyRows: current.qtyRows.map((r) => (r.id === row.id ? { ...r, key: value } : r)),
                          }))
                        }
                        autoComplete="off"
                      />
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <TextField
                          label="Max units"
                          labelHidden
                          type="number"
                          min={1}
                          value={row.max}
                          onChange={(value) =>
                            setVisual((current) => ({
                              ...current,
                              qtyRows: current.qtyRows.map((r) => (r.id === row.id ? { ...r, max: value } : r)),
                            }))
                          }
                          autoComplete="off"
                        />
                        <Button
                          tone="critical"
                          variant="plain"
                          onClick={() =>
                            setVisual((current) => ({ ...current, qtyRows: current.qtyRows.filter((r) => r.id !== row.id) }))
                          }
                        >
                          Remove
                        </Button>
                      </InlineStack>
                    </InlineGrid>
                  ))}
                  <InlineStack>
                    <Button size="slim" onClick={() => setVisual((current) => ({ ...current, qtyRows: [...current.qtyRows, newRow()] }))}>
                      Add limit
                    </Button>
                  </InlineStack>
                </BlockStack>
              )}
              {toggles.enable_quantity && mode === "json" && jsonField("quantity_limits", "quantity_limits (JSON object)", 4)}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <PageActions
            primaryAction={{
              content: "Save rules",
              onAction: () => submit("save"),
              disabled: busy || hasJsonErrors,
              loading: busy,
            }}
            secondaryActions={[
              {
                content: "Check impact on recent orders",
                onAction: () => submit("simulate"),
                disabled: busy || hasJsonErrors,
              },
            ]}
          />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
