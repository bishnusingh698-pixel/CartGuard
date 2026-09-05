/**
 * CartGuard — Admin settings route (Remix + Polaris).
 *
 * Architectural notes:
 *  - Parent route (app/routes/app.tsx) provides the App Bridge frame, so this
 *    page MUST render a React Fragment as its parent — no <Frame> wrapper.
 *  - All configuration lives in Shop Metafields (namespace "cartguard",
 *    type single_line_text_field, stringified JSON). No external database.
 *  - Impact Checker (Feature 6): "Check impact" and "Save" both run the
 *    simulator against the last 100 orders server-side. Saving with a
 *    non-zero projected impact shows a warning banner + explicit confirm
 *    before the metafield write is finalized.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  List,
  Page,
  PageActions,
  Text,
  TextField,
} from "@shopify/polaris";

// Provided by the Shopify Remix template's app/shopify.server.ts scaffold.
import { authenticate } from "../shopify.server";

import {
  type ActionResponse,
  type CartGuardSettings,
  type ImpactResult,
  CARTGUARD_METAFIELDS_QUERY,
  FEATURE_FLAGS,
  parseDraftConfig,
  parseSettings,
  prettyJson,
  simulateImpact,
  validateDraftConfig,
  writeConfiguration,
} from "../lib/cartguard.server";

/* ────────────────────────────────────────────────────────────────────────────
 * Loader — read current configuration from Shop metafields
 * ──────────────────────────────────────────────────────────────────────────── */

const EXAMPLES = {
  vip_allowlist: '["vip@yourstore.com", "wholesale@partner.io"]',
  regex_rules:
    '[\n  {\n    "pattern": "p\\\\.?o\\\\.? box|post office box",\n    "message": "We are unable to deliver to PO Boxes. Please provide a street address."\n  },\n  {\n    "pattern": "freight forwarder|forwarding (company|agent)|reship",\n    "message": "We are unable to deliver to freight forwarders."\n  }\n]',
  quantity_limits: '{\n  "bulk": 10,\n  "reseller": 25\n}',
  geo_blocklist: '{\n  "zips": [],\n  "cities": [],\n  "states": []\n}',
};

type LoaderData = {
  settings: CartGuardSettings;
  fields: {
    vip_allowlist: string;
    regex_rules: string;
    quantity_limits: string;
    geo_blocklist: string;
  };
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(CARTGUARD_METAFIELDS_QUERY);
  const body = (await response.json()) as {
    data?: {
      shop?: {
        metafields?: {
          nodes?: Array<{ key?: string | null; value?: string | null } | null> | null;
        } | null;
      } | null;
    };
  };

  const metafields = body?.data?.shop?.metafields?.nodes ?? [];
  const valueOf = (key: string): string | null => {
    const match = metafields.find((metafield) => metafield?.key === key);
    return typeof match?.value === "string" ? match.value : null;
  };

  return json<LoaderData>({
    settings: parseSettings(valueOf("settings")),
    fields: {
      vip_allowlist: prettyJson(valueOf("vip_allowlist"), ""),
      regex_rules: prettyJson(valueOf("regex_rules"), ""),
      quantity_limits: prettyJson(valueOf("quantity_limits"), ""),
      geo_blocklist: prettyJson(valueOf("geo_blocklist"), ""),
    },
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Action — simulate impact / save configuration
 * ──────────────────────────────────────────────────────────────────────────── */

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");
  const confirmed = String(form.get("confirmed") ?? "false") === "true";

  const draft = {
    regex_rules: String(form.get("regex_rules") ?? ""),
    quantity_limits: String(form.get("quantity_limits") ?? ""),
    geo_blocklist: String(form.get("geo_blocklist") ?? ""),
    vip_allowlist: String(form.get("vip_allowlist") ?? ""),
  };

  const settings = {} as CartGuardSettings;
  for (const flag of FEATURE_FLAGS) {
    settings[flag] = String(form.get(flag) ?? "false") === "true";
  }

  try {
    // Strict validation first — a save should never write malformed JSON
    // even though the checkout Function itself stays fail-open.
    const fieldErrors = validateDraftConfig(draft);
    if (Object.keys(fieldErrors).length > 0) {
      return json<ActionResponse>({
        ok: false,
        fieldErrors,
        message: "Fix the highlighted JSON before saving.",
      });
    }

    const rules = parseDraftConfig(draft);

    if (intent === "simulate") {
      const impact = await simulateImpact(admin, rules, settings);
      return json<ActionResponse>({ ok: true, impact, needsConfirm: false, saved: false });
    }

    // Feature 6: simulate BEFORE finalizing the save.
    const impact = await simulateImpact(admin, rules, settings);
    if (!confirmed && impact.blocked > 0) {
      return json<ActionResponse>({ ok: true, needsConfirm: true, impact, saved: false });
    }

    await writeConfiguration(admin, rules, settings);
    return json<ActionResponse>({ ok: true, saved: true, needsConfirm: false, impact });
  } catch (error) {
    return json<ActionResponse>(
      { ok: false, message: `CartGuard could not complete the request: ${(error as Error).message}` },
      { status: 500 },
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Client-side JSON validation
 * ──────────────────────────────────────────────────────────────────────────── */

type JsonKind = "array" | "object";

function jsonValidationError(value: string, kind: JsonKind): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null; // empty → metafield saved as the empty default
  try {
    const parsed = JSON.parse(trimmed);
    if (kind === "array" && !Array.isArray(parsed)) {
      return "Expected a JSON array, e.g. [ ... ].";
    }
    if (kind === "object" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
      return "Expected a JSON object, e.g. { ... }.";
    }
    return null;
  } catch (error) {
    return `Invalid JSON: ${(error as Error).message}`;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Settings page
 * ──────────────────────────────────────────────────────────────────────────── */

export default function CartGuardSettingsPage() {
  const { settings: initialSettings, fields: initialFields } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResponse>();

  const [toggles, setToggles] = useState<CartGuardSettings>(initialSettings);
  const [vipJson, setVipJson] = useState(initialFields.vip_allowlist);
  const [regexJson, setRegexJson] = useState(initialFields.regex_rules);
  const [qtyJson, setQtyJson] = useState(initialFields.quantity_limits);
  const [geoJson, setGeoJson] = useState(initialFields.geo_blocklist);

  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [saved, setSaved] = useState(false);

  // ── Client-side JSON validation ────────────────────────────────────────────
  const errors = useMemo(
    () => ({
      vip_allowlist: jsonValidationError(vipJson, "array"),
      regex_rules: jsonValidationError(regexJson, "array"),
      quantity_limits: jsonValidationError(qtyJson, "object"),
      geo_blocklist: jsonValidationError(geoJson, "object"),
    }),
    [vipJson, regexJson, qtyJson, geoJson],
  );
  const hasJsonErrors = Object.values(errors).some(Boolean);

  const busy = fetcher.state !== "idle";

  // ── Submission ─────────────────────────────────────────────────────────────
  const submit = useCallback(
    (intent: "simulate" | "save", confirmed = false) => {
      fetcher.submit(
        {
          intent,
          confirmed: String(confirmed),
          enable_vip: String(toggles.enable_vip),
          enable_po_box: String(toggles.enable_po_box),
          enable_quantity: String(toggles.enable_quantity),
          enable_geo: String(toggles.enable_geo),
          enable_mismatch: String(toggles.enable_mismatch),
          vip_allowlist: vipJson,
          regex_rules: regexJson,
          quantity_limits: qtyJson,
          geo_blocklist: geoJson,
        },
        { method: "post" },
      );
    },
    [fetcher, toggles, vipJson, regexJson, qtyJson, geoJson],
  );

  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;
    if (data.saved) {
      setSaved(true);
      setNeedsConfirm(false);
      setImpact(data.impact ?? null);
      if (typeof window !== "undefined") {
        const shopifyGlobal = (window as unknown as { shopify?: { toast?: { show?: (msg: string) => void } } }).shopify;
        shopifyGlobal?.toast?.show?.("CartGuard rules saved. Configuration is live at checkout.");
      }
    } else if (data.needsConfirm) {
      setSaved(false);
      setNeedsConfirm(true);
      setImpact(data.impact ?? null);
    } else if (data.impact) {
      setSaved(false);
      setNeedsConfirm(false);
      setImpact(data.impact);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const setToggle = (flag: keyof CartGuardSettings) => (value: boolean) =>
    setToggles((current) => ({ ...current, [flag]: value }));

  const blockedPercent =
    impact && impact.scanned > 0 ? Math.round((impact.blocked / impact.scanned) * 100) : 0;

  // ── Render ─────────────────────────────────────────────────────────────────
  // CONSTRAINT: fragment parent — the parent route provides the frame; <Frame>
  // must NOT be used here.
  return (
    <>
      <Page
        title="CartGuard"
        subtitle="Fraud prevention rules enforced at checkout via Shopify Functions."
      >
        <Layout>
          {/* ── Feedback banners ──────────────────────────────────────────── */}
          {saved && (
            <Layout.Section>
              <Banner
                title="Configuration saved"
                tone="success"
                onDismiss={() => setSaved(false)}
              >
                <Text as="p">
                  The cartguard metafields were updated. Ensure the “CartGuard Validator”
                  function is enabled under Settings → Checkout → Customizations so the
                  rules run on your checkout.
                </Text>
              </Banner>
            </Layout.Section>
          )}

          {needsConfirm && impact && (
            <Layout.Section>
              <Banner
                title="Impact check before saving"
                tone="warning"
                action={{ content: "Save anyway", onAction: () => submit("save", true) }}
                secondaryAction={{ content: "Cancel", onAction: () => setNeedsConfirm(false) }}
                onDismiss={() => setNeedsConfirm(false)}
              >
                <BlockStack gap="200">
                  <Text as="p" fontWeight="semibold">
                    These rules would have blocked {impact.blocked} of your last{" "}
                    {impact.scanned} orders ({blockedPercent}%).
                  </Text>
                  {impact.samples.length > 0 && (
                    <List>
                      {impact.samples.map((sample) => (
                        <List.Item key={sample}>{sample}</List.Item>
                      ))}
                    </List>
                  )}
                  <Text as="p" tone="subdued">
                    Review the examples above, adjust the rules, or confirm to finalize
                    the save.
                  </Text>
                </BlockStack>
              </Banner>
            </Layout.Section>
          )}

          {!saved && !needsConfirm && impact && (
            <Layout.Section>
              <Banner
                title="Impact check"
                tone={impact.blocked > 0 ? "warning" : "success"}
                onDismiss={() => setImpact(null)}
              >
                <BlockStack gap="200">
                  <Text as="p" fontWeight="semibold">
                    {impact.blocked} of the last {impact.scanned} orders would have been
                    blocked by these rules ({blockedPercent}%).
                  </Text>
                  {impact.samples.length > 0 && (
                    <List>
                      {impact.samples.map((sample) => (
                        <List.Item key={sample}>{sample}</List.Item>
                      ))}
                    </List>
                  )}
                </BlockStack>
              </Banner>
            </Layout.Section>
          )}

          {fetcher.data?.message && (
            <Layout.Section>
              <Banner title="Action failed" tone="critical" onDismiss={() => {}}>
                <Text as="p">{fetcher.data.message}</Text>
              </Banner>
            </Layout.Section>
          )}

          {/* ── Rule pipeline summary ─────────────────────────────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  How CartGuard evaluates orders
                </Text>
                <List>
                  <List.Item>
                    <strong>VIP Allowlist</strong> — checked first; matching buyers bypass
                    every other rule.
                  </List.Item>
                  <List.Item>
                    <strong>Bulk Quantity Limiter</strong> — runs on every checkout step.
                  </List.Item>
                  <List.Item>
                    <strong>PO Box &amp; Freight Forwarder Blocker</strong> — runs at
                    checkout completion only.
                  </List.Item>
                  <List.Item>
                    <strong>Geographic Zone Blocker</strong> — zips, cities and
                    states/provinces, across every delivery group.
                  </List.Item>
                  <List.Item>
                    <strong>Smart Mismatch Detector</strong> — high-risk shipping address
                    that differs from the billing address.
                  </List.Item>
                </List>
                <Text as="p" tone="subdued">
                  Fail-open guarantee: missing or malformed configuration never crashes
                  checkout — the affected rule is skipped and the checkout proceeds.
                  A newly installed app is inert until you enable rules below.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Feature 5: VIP Allowlist ──────────────────────────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  VIP Allowlist
                </Text>
                <Checkbox
                  label="Enable VIP allowlist bypass"
                  helpText="Checked first on every rule run — buyers on this list are never blocked by CartGuard."
                  checked={toggles.enable_vip}
                  onChange={setToggle("enable_vip")}
                />
                <TextField
                  label="vip_allowlist (JSON array of emails or street addresses)"
                  placeholder={EXAMPLES.vip_allowlist}
                  value={vipJson}
                  onChange={setVipJson}
                  multiline={4}
                  monospaced
                  autoComplete="off"
                  error={errors.vip_allowlist ?? undefined}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Feature 1: PO Box & Freight Forwarder Blocker ─────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  PO Box &amp; Freight Forwarder Blocker
                </Text>
                <Checkbox
                  label="Enable address pattern blocking"
                  helpText="Tests delivery address line 1 and 2 (case-insensitive) at checkout completion only."
                  checked={toggles.enable_po_box}
                  onChange={setToggle("enable_po_box")}
                />
                <TextField
                  label="regex_rules (JSON array of { pattern, message })"
                  placeholder={EXAMPLES.regex_rules}
                  value={regexJson}
                  onChange={setRegexJson}
                  multiline={8}
                  monospaced
                  autoComplete="off"
                  error={errors.regex_rules ?? undefined}
                />
                <Text as="p" tone="subdued">
                  The same patterns also feed the Smart Mismatch Detector as
                  high-risk signals.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Feature 2: Bulk Quantity Limiter ──────────────────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Bulk Quantity Limiter
                </Text>
                <Checkbox
                  label="Enable quantity limits by product tag"
                  helpText="Runs on every checkout step. Quantities are aggregated per product across all cart lines."
                  checked={toggles.enable_quantity}
                  onChange={setToggle("enable_quantity")}
                />
                <TextField
                  label="quantity_limits (JSON object of { tag: max })"
                  placeholder={EXAMPLES.quantity_limits}
                  value={qtyJson}
                  onChange={setQtyJson}
                  multiline={5}
                  monospaced
                  autoComplete="off"
                  error={errors.quantity_limits ?? undefined}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Feature 3: Geographic Zone Blocker ────────────────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Geographic Zone Blocker
                </Text>
                <Checkbox
                  label="Enable geographic blocking"
                  helpText="Compares the delivery ZIP, city and state/province code against your blocklists (case-insensitive)."
                  checked={toggles.enable_geo}
                  onChange={setToggle("enable_geo")}
                />
                <TextField
                  label="geo_blocklist (JSON object with zips / cities / states arrays)"
                  placeholder={EXAMPLES.geo_blocklist}
                  value={geoJson}
                  onChange={setGeoJson}
                  multiline={6}
                  monospaced
                  autoComplete="off"
                  error={errors.geo_blocklist ?? undefined}
                />
                <Text as="p" tone="subdued">
                  Use two-letter province/state codes in “states” (e.g. “NY”, “ON”).
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Feature 4: Smart Mismatch Detector ────────────────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Smart Mismatch Detector
                </Text>
                <Checkbox
                  label="Enable billing/shipping mismatch detection"
                  helpText="Warns when the shipping address matches a high-risk regex_rules pattern AND differs from the billing address."
                  checked={toggles.enable_mismatch}
                  onChange={setToggle("enable_mismatch")}
                />
                <Text as="p" tone="subdued">
                  Billing address is not exposed by the checkout Function input today,
                  so the rule stays inert (fail-open) at checkout until the API exposes
                  it. The Impact Checker always simulates this rule fully using real
                  historical billing addresses.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Actions (Feature 6 entrypoints) ───────────────────────────── */}
          <Layout.Section>
            <PageActions
              primaryAction={{
                content: "Save rules",
                onAction: () => submit("save"),
                disabled: busy || hasJsonErrors,
              }}
              secondaryActions={[
                {
                  content: "Check impact on last 100 orders",
                  onAction: () => submit("simulate"),
                  disabled: busy || hasJsonErrors,
                },
              ]}
            />
          </Layout.Section>

          <Layout.Section>
            <InlineStack align="end">
              <Button
                onClick={() => submit("simulate")}
                loading={busy}
                disabled={hasJsonErrors}
              >
                Simulate impact again
              </Button>
            </InlineStack>
          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}

/*
 * `authenticate` is re-exported by the Shopify Remix template's
 * app/shopify.server.ts (shopifyApp({ ... }).authenticate). Both handlers
 * above resolve the embedded-session admin context via
 * `await authenticate.admin(request)` and use `admin.graphql(...)`.
 */
