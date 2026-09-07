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

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

/* ────────────────────────────────────────────────────────────────────────────
 * Loader — read current configuration from Shop metafields
 * ──────────────────────────────────────────────────────────────────────────── */

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
    const fieldErrors = validateDraftConfig(draft);
    if (Object.keys(fieldErrors).length > 0) {
      return json<ActionResponse>({
        ok: false,
        fieldErrors,
        message: "Please check your rules configuration before saving.",
      });
    }

    const rules = parseDraftConfig(draft);

    if (intent === "simulate") {
      const impact = await simulateImpact(admin, rules, settings);
      return json<ActionResponse>({ ok: true, impact, needsConfirm: false, saved: false });
    }

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
 * Client-side Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

type JsonKind = "array" | "object";

function jsonValidationError(value: string, kind: JsonKind): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (kind === "array" && !Array.isArray(parsed)) {
      return "Expected an array list.";
    }
    if (kind === "object" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
      return "Expected a key-value object.";
    }
    return null;
  } catch (error) {
    return `Formatting issue: ${(error as Error).message}`;
  }
}

function safeParseArray(raw: string): string[] {
  try {
    const val = JSON.parse(raw);
    return Array.isArray(val) ? val.map(String) : [];
  } catch {
    return [];
  }
}

function safeParseGeo(raw: string): { zips: string[]; cities: string[]; states: string[] } {
  try {
    const val = JSON.parse(raw);
    return {
      zips: Array.isArray(val?.zips) ? val.zips.map(String) : [],
      cities: Array.isArray(val?.cities) ? val.cities.map(String) : [],
      states: Array.isArray(val?.states) ? val.states.map(String) : [],
    };
  } catch {
    return { zips: [], cities: [], states: [] };
  }
}

function safeParseQty(raw: string): Array<{ tag: string; max: number }> {
  try {
    const val = JSON.parse(raw);
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return Object.entries(val).map(([tag, limit]) => ({
        tag,
        max: typeof limit === "number" ? limit : typeof limit === "object" && limit !== null && "max" in limit ? Number((limit as { max: number }).max) : 1,
      }));
    }
    return [];
  } catch {
    return [];
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

  // Friendly Visual UI State
  const [useDeveloperMode, setUseDeveloperMode] = useState(false);

  // VIP
  const initialVip = useMemo(() => safeParseArray(initialFields.vip_allowlist), [initialFields.vip_allowlist]);
  const [vipInput, setVipInput] = useState(initialVip.join("\n"));

  // PO Box & Freight
  const [blockPoBox, setBlockPoBox] = useState(true);
  const [blockFreight, setBlockFreight] = useState(true);
  const [blockApoFpo, setBlockApoFpo] = useState(true);
  const [customKeywords, setCustomKeywords] = useState("");

  // Geo Blocklist
  const initialGeo = useMemo(() => safeParseGeo(initialFields.geo_blocklist), [initialFields.geo_blocklist]);
  const [geoZips, setGeoZips] = useState(initialGeo.zips.join(", "));
  const [geoCities, setGeoCities] = useState(initialGeo.cities.join(", "));
  const [geoStates, setGeoStates] = useState(initialGeo.states.join(", "));

  // Quantity Limits
  const initialQtyList = useMemo(() => safeParseQty(initialFields.quantity_limits), [initialFields.quantity_limits]);
  const [qtyRows, setQtyRows] = useState<Array<{ tag: string; max: number }>>(
    initialQtyList.length > 0 ? initialQtyList : [{ tag: "bulk", max: 10 }]
  );

  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Sync friendly VIP inputs to JSON
  const handleVipChange = (val: string) => {
    setVipInput(val);
    const parsed = val
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    setVipJson(JSON.stringify(parsed, null, 2));
  };

  // Sync friendly Geo inputs to JSON
  const syncGeoToJson = (zipsStr: string, citiesStr: string, statesStr: string) => {
    const parseItems = (str: string) =>
      str
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);

    const geoObj = {
      zips: parseItems(zipsStr),
      cities: parseItems(citiesStr),
      states: parseItems(statesStr),
    };
    setGeoJson(JSON.stringify(geoObj, null, 2));
  };

  // Sync friendly PO Box / Freight toggles to JSON
  const syncRegexToJson = (po: boolean, freight: boolean, apo: boolean, custom: string) => {
    const rules: Array<{ pattern: string; message: string }> = [];
    if (po) {
      rules.push({
        pattern: "p\\.?o\\.? box|post office box|postal box|apartado postal",
        message: "We cannot ship to PO Boxes. Please provide a valid physical street address.",
      });
    }
    if (freight) {
      rules.push({
        pattern: "freight forwarder|forwarding (company|agent)|reship|reshipper|transshipment|suite \\d{3,}",
        message: "We do not ship to freight forwarders or reshippers.",
      });
    }
    if (apo) {
      rules.push({
        pattern: "\\b(apo|fpo|dpo)\\b",
        message: "We are unable to deliver to military addresses (APO/FPO/DPO).",
      });
    }
    const customs = custom
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (customs.length > 0) {
      rules.push({
        pattern: customs.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        message: "Your shipping address contains restricted keywords.",
      });
    }
    setRegexJson(JSON.stringify(rules, null, 2));
  };

  // Sync Quantity Rows to JSON
  const syncQtyToJson = (rows: Array<{ tag: string; max: number }>) => {
    const obj: Record<string, number> = {};
    for (const r of rows) {
      if (r.tag.trim()) {
        obj[r.tag.trim()] = Number(r.max) || 1;
      }
    }
    setQtyJson(JSON.stringify(obj, null, 2));
  };

  // Client-side JSON validation
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
    if (data.message && !data.ok) {
      setActionError(data.message);
    } else {
      setActionError(null);
    }
    if (data.saved) {
      setSaved(true);
      setNeedsConfirm(false);
      setImpact(data.impact ?? null);
      if (typeof window !== "undefined") {
        const shopifyGlobal = (window as unknown as { shopify?: { toast?: { show?: (msg: string) => void } } }).shopify;
        shopifyGlobal?.toast?.show?.("CartGuard rules saved. Active at checkout!");
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
  }, [fetcher.data]);

  const setToggle = (flag: keyof CartGuardSettings) => (value: boolean) =>
    setToggles((current) => ({ ...current, [flag]: value }));

  const blockedPercent =
    impact && impact.scanned > 0 ? Math.round((impact.blocked / impact.scanned) * 100) : 0;

  return (
    <>
      <Page
        title="CartGuard Protection Control"
        subtitle="Automatic fraud and checkout restrictions powered by native Shopify Functions."
        secondaryActions={[
          {
            content: useDeveloperMode ? "Switch to Visual Mode" : "Developer Mode (JSON)",
            onAction: () => setUseDeveloperMode((v) => !v),
          },
        ]}
      >
        <Layout>
          {saved && (
            <Layout.Section>
              <Banner
                title="Rules successfully saved & live"
                tone="success"
                onDismiss={() => setSaved(false)}
              >
                <Text as="p">
                  Your CartGuard rules have been updated and are now evaluated directly during checkout.
                </Text>
              </Banner>
            </Layout.Section>
          )}

          {needsConfirm && impact && (
            <Layout.Section>
              <Banner
                title="Review impact before finalizing"
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
                    Confirm if you would like to proceed with activating these rules.
                  </Text>
                </BlockStack>
              </Banner>
            </Layout.Section>
          )}

          {!saved && !needsConfirm && impact && (
            <Layout.Section>
              <Banner
                title="Impact check result"
                tone={impact.blocked > 0 ? "warning" : "success"}
                onDismiss={() => setImpact(null)}
              >
                <BlockStack gap="200">
                  <Text as="p" fontWeight="semibold">
                    {impact.blocked} of the last {impact.scanned} past store orders would have been
                    blocked ({blockedPercent}%).
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

          {actionError && (
            <Layout.Section>
              <Banner title="Action failed" tone="critical" onDismiss={() => setActionError(null)}>
                <Text as="p">{actionError}</Text>
              </Banner>
            </Layout.Section>
          )}

          {/* ── Feature 5: VIP Whitelist ──────────────────────────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    VIP Customer Allowlist
                  </Text>
                  {toggles.enable_vip && <Badge tone="success">Active</Badge>}
                </InlineStack>
                <Checkbox
                  label="Enable VIP Customer Bypass"
                  helpText="VIP customers bypass all checkout restrictions, geographic blocks, and quantity limits."
                  checked={toggles.enable_vip}
                  onChange={setToggle("enable_vip")}
                />

                {toggles.enable_vip && !useDeveloperMode && (
                  <BlockStack gap="200">
                    <TextField
                      label="VIP Customer Emails or Street Addresses"
                      helpText="Enter customer email addresses or street addresses (one per line or separated by commas)."
                      placeholder="vip@customer.com&#10;wholesale@partner.store&#10;123 Executive Blvd"
                      value={vipInput}
                      onChange={handleVipChange}
                      multiline={3}
                      autoComplete="off"
                    />
                    <InlineStack gap="200" wrap>
                      {vipInput
                        .split(/[\n,]+/)
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .map((item) => (
                          <Tag key={item}>{item}</Tag>
                        ))}
                    </InlineStack>
                  </BlockStack>
                )}

                {toggles.enable_vip && useDeveloperMode && (
                  <TextField
                    label="vip_allowlist (Raw JSON array)"
                    value={vipJson}
                    onChange={setVipJson}
                    multiline={3}
                    monospaced
                    autoComplete="off"
                    error={errors.vip_allowlist ?? undefined}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Feature 1: PO Box & Freight Forwarder Blocker ─────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    PO Box &amp; Freight Forwarder Blocker
                  </Text>
                  {toggles.enable_po_box && <Badge tone="success">Active</Badge>}
                </InlineStack>
                <Checkbox
                  label="Enable Address Protection"
                  helpText="Inspects customer delivery address at checkout completion to stop undeliverable or fraud-risk orders."
                  checked={toggles.enable_po_box}
                  onChange={setToggle("enable_po_box")}
                />

                {toggles.enable_po_box && !useDeveloperMode && (
                  <BlockStack gap="300">
                    <Checkbox
                      label="Block PO Boxes and Postal Lockers (e.g., P.O. Box, Apartado Postal)"
                      checked={blockPoBox}
                      onChange={(v) => {
                        setBlockPoBox(v);
                        syncRegexToJson(v, blockFreight, blockApoFpo, customKeywords);
                      }}
                    />
                    <Checkbox
                      label="Block Freight Forwarders and Reshippers (e.g., forwarding company, reship)"
                      checked={blockFreight}
                      onChange={(v) => {
                        setBlockFreight(v);
                        syncRegexToJson(blockPoBox, v, blockApoFpo, customKeywords);
                      }}
                    />
                    <Checkbox
                      label="Block Military APO / FPO / DPO delivery addresses"
                      checked={blockApoFpo}
                      onChange={(v) => {
                        setBlockApoFpo(v);
                        syncRegexToJson(blockPoBox, blockFreight, v, customKeywords);
                      }}
                    />
                    <TextField
                      label="Custom Blocked Keywords or Phrases (optional)"
                      helpText="Add any custom terms separated by commas (e.g., warehouse 4B, reshipper)"
                      value={customKeywords}
                      onChange={(val) => {
                        setCustomKeywords(val);
                        syncRegexToJson(blockPoBox, blockFreight, blockApoFpo, val);
                      }}
                      autoComplete="off"
                    />
                  </BlockStack>
                )}

                {toggles.enable_po_box && useDeveloperMode && (
                  <TextField
                    label="regex_rules (Raw JSON array)"
                    value={regexJson}
                    onChange={setRegexJson}
                    multiline={6}
                    monospaced
                    autoComplete="off"
                    error={errors.regex_rules ?? undefined}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Feature 3: Geographic Zone Blocker ────────────────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Geographic Zone &amp; Regional Blocker
                  </Text>
                  {toggles.enable_geo && <Badge tone="success">Active</Badge>}
                </InlineStack>
                <Checkbox
                  label="Enable Geographic Delivery Restrictions"
                  helpText="Block delivery to specific states, provinces, cantons, cities, or postal codes worldwide (e.g. Costa Rica, Kiribati, USA, Canada)."
                  checked={toggles.enable_geo}
                  onChange={setToggle("enable_geo")}
                />

                {toggles.enable_geo && !useDeveloperMode && (
                  <BlockStack gap="300">
                    <TextField
                      label="Blocked Postal / Zip Codes"
                      helpText="Comma-separated or one per line (e.g. 10101, 20101, 90210)"
                      placeholder="10101, 20101, 90210"
                      value={geoZips}
                      onChange={(val) => {
                        setGeoZips(val);
                        syncGeoToJson(val, geoCities, geoStates);
                      }}
                      autoComplete="off"
                    />
                    <TextField
                      label="Blocked Cities / Cantons / Atolls"
                      helpText="Comma-separated (e.g. San José, Alajuela, Tarawa, Kiritimati)"
                      placeholder="San José, Alajuela, Tarawa"
                      value={geoCities}
                      onChange={(val) => {
                        setGeoCities(val);
                        syncGeoToJson(geoZips, val, geoStates);
                      }}
                      autoComplete="off"
                    />
                    <TextField
                      label="Blocked States / Provinces / Regions"
                      helpText="Comma-separated (e.g. Guanacaste, Limón, Line Islands, NY, CA)"
                      placeholder="Guanacaste, Limón, Phoenix Islands, CA, NY"
                      value={geoStates}
                      onChange={(val) => {
                        setGeoStates(val);
                        syncGeoToJson(geoZips, geoCities, val);
                      }}
                      autoComplete="off"
                    />
                  </BlockStack>
                )}

                {toggles.enable_geo && useDeveloperMode && (
                  <TextField
                    label="geo_blocklist (Raw JSON)"
                    value={geoJson}
                    onChange={setGeoJson}
                    multiline={5}
                    monospaced
                    autoComplete="off"
                    error={errors.geo_blocklist ?? undefined}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Feature 2: Bulk Quantity Limiter ──────────────────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Bulk Quantity Limiter
                  </Text>
                  {toggles.enable_quantity && <Badge tone="success">Active</Badge>}
                </InlineStack>
                <Checkbox
                  label="Enable Quantity Limits by Product Tag"
                  helpText="Prevents resellers or bots from ordering excessive units of tagged products."
                  checked={toggles.enable_quantity}
                  onChange={setToggle("enable_quantity")}
                />

                {toggles.enable_quantity && !useDeveloperMode && (
                  <BlockStack gap="300">
                    <Text as="p" tone="subdued">
                      Specify product tags and the maximum units allowed per checkout:
                    </Text>
                    {qtyRows.map((row, idx) => (
                      <InlineGrid columns={["twoThirds", "oneThird"]} gap="200" key={idx}>
                        <TextField
                          label="Product Tag"
                          labelHidden
                          placeholder="e.g. bulk, limited-edition"
                          value={row.tag}
                          onChange={(val) => {
                            const copy = [...qtyRows];
                            copy[idx].tag = val;
                            setQtyRows(copy);
                            syncQtyToJson(copy);
                          }}
                          autoComplete="off"
                        />
                        <InlineStack gap="200" blockAlign="center">
                          <TextField
                            label="Max Units"
                            labelHidden
                            type="number"
                            min={1}
                            placeholder="Max units"
                            value={String(row.max)}
                            onChange={(val) => {
                              const copy = [...qtyRows];
                              copy[idx].max = parseInt(val, 10) || 1;
                              setQtyRows(copy);
                              syncQtyToJson(copy);
                            }}
                            autoComplete="off"
                          />
                          {qtyRows.length > 1 && (
                            <Button
                              tone="critical"
                              variant="plain"
                              onClick={() => {
                                const copy = qtyRows.filter((_, i) => i !== idx);
                                setQtyRows(copy);
                                syncQtyToJson(copy);
                              }}
                            >
                              Remove
                            </Button>
                          )}
                        </InlineStack>
                      </InlineGrid>
                    ))}
                    <InlineStack>
                      <Button
                        size="slim"
                        onClick={() => {
                          const copy = [...qtyRows, { tag: "", max: 5 }];
                          setQtyRows(copy);
                        }}
                      >
                        + Add Tag Limit
                      </Button>
                    </InlineStack>
                  </BlockStack>
                )}

                {toggles.enable_quantity && useDeveloperMode && (
                  <TextField
                    label="quantity_limits (Raw JSON)"
                    value={qtyJson}
                    onChange={setQtyJson}
                    multiline={4}
                    monospaced
                    autoComplete="off"
                    error={errors.quantity_limits ?? undefined}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Feature 4: Smart Mismatch Detector ────────────────────────── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Smart Mismatch Detector
                  </Text>
                  {toggles.enable_mismatch && <Badge tone="success">Active</Badge>}
                </InlineStack>
                <Checkbox
                  label="Enable Billing / Shipping Mismatch Check"
                  helpText="Detects when an order ships to a high-risk location that differs completely from the cardholder billing address."
                  checked={toggles.enable_mismatch}
                  onChange={setToggle("enable_mismatch")}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Actions ───────────────────────────────────────────────────── */}
          <Layout.Section>
            <PageActions
              primaryAction={{
                content: "Save rules",
                onAction: () => submit("save"),
                disabled: busy || (useDeveloperMode && hasJsonErrors),
                loading: busy,
              }}
              secondaryActions={[
                {
                  content: "Check impact on past 100 orders",
                  onAction: () => submit("simulate"),
                  disabled: busy || (useDeveloperMode && hasJsonErrors),
                },
              ]}
            />
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
