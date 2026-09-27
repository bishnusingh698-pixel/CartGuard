/**
 * CartGuard block rules (Remix + Polaris).
 *
 * - Every rule is built with form controls. Merchants never see code or raw
 *   data; the form state lives in app/lib/rule-editor.ts.
 * - Rules are stored in app-owned shop metafields ($app:cartguard, json).
 * - Saving also makes sure CartGuard's checkout rule (a Shopify Validation
 *   running the cartguard-validator Function) exists and is enabled.
 * - "Test on recent orders" simulates the rules on recent orders with the
 *   same rule engine the checkout Function uses.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isRouteErrorResponse, useBlocker, useFetcher, useLoaderData, useRouteError } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  List,
  Page,
  PageActions,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import { errorMessage, friendlyErrorMessage } from "../lib/admin-api.server";
import {
  type ActionResponse,
  type ImpactResult,
  saveConfiguration,
  simulateImpact,
  validateRuleConfig,
} from "../lib/cartguard.server";
import { type RulesState, getAdmin, loadRulesState } from "../lib/dashboard.server";
import { type ValidationStatus } from "../lib/validation.server";
import { CountryPicker, ListField, RegionPicker } from "../components/rule-fields";
import { SectionBadge, sectionStatusText } from "../components/section-status";
import { describeScopedEntry, getCountryOptions, type Option } from "../lib/regions";
import {
  LIST_FIELD_IDS,
  MAX_UNITS,
  MESSAGE_MAX_LENGTH,
  configFromEditor,
  editorFromConfig,
  newAddressRule,
  newLimit,
  parseCity,
  parseKeyword,
  parseVipAddress,
  parseVipEmail,
  parseZip,
  validateEditor,
  withCountryScope,
  type AddressMatch,
  type AddressRuleRow,
  type BuiltInCheck,
  type EditorState,
  type LimitRow,
  type LimitTarget,
} from "../lib/rule-editor";
import {
  RULE_SECTIONS,
  SECTION_META,
  type RuleSection,
  type SectionSummary,
  formatNumber,
  formatShare,
  pluralize,
  summarizeSections,
} from "../lib/rule-summary";
import {
  DEFAULT_ADDRESS_MESSAGE,
  isRecord,
  type FeatureFlag,
} from "../../extensions/cartguard-validator/src/rules";

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

/* ── Loader ─────────────────────────────────────────────────────────────────────── */

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, isDemo } = await getAdmin(request);
  return json<RulesState>(await loadRulesState(admin, isDemo));
}

/* ── Action ────────────────────────────────────────────────────────────────────── */

type Intent = "simulate" | "save";

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await getAdmin(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const payload = isRecord(body) ? body : {};
  const intent: Intent = payload.intent === "simulate" ? "simulate" : "save";
  const confirmed = payload.confirmed === true;

  const { config, errors } = validateRuleConfig(payload.config);
  if (!config) {
    return json<ActionResponse>(
      { ok: false, sectionErrors: errors, message: "Some rules need fixing before they can be saved." },
      { status: 400 },
    );
  }

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
        console.warn("[CartGuard] Impact check failed before save:", errorMessage(error));
        return json<ActionResponse>({
          ok: true,
          needsConfirm: true,
          impactError: `We couldn't test these rules on your recent orders. ${friendlyErrorMessage(error)} You can still save them.`,
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
    console.error("[CartGuard] Rules action failed:", error);
    return json<ActionResponse>(
      {
        ok: false,
        message: `${intent === "simulate" ? "The test didn't finish." : "Your rules weren't saved."} ${friendlyErrorMessage(error)}`,
      },
      { status: 500 },
    );
  }
}

/* ── Presentational pieces ─────────────────────────────────────────────────────── */

type RuleSectionCardProps = {
  section: RuleSection;
  summary: SectionSummary;
  errorCount: number;
  serverError?: string;
  onToggle: (enabled: boolean) => void;
  children: ReactNode;
};

function RuleSectionCard({ section, summary, errorCount, serverError, onToggle, children }: RuleSectionCardProps) {
  const meta = SECTION_META[section];
  // Entries stay saved while a section is off. If they need fixing, show them
  // anyway so a hidden problem can never block saving.
  const showBody = summary.enabled || errorCount > 0 || Boolean(serverError);
  const toggleLabel = summary.enabled ? "Turn off" : "Turn on";
  return (
    <Layout.AnnotatedSection id={meta.anchor} title={meta.title} description={meta.description}>
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="100">
              <InlineStack>
                <SectionBadge summary={summary} />
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                {sectionStatusText(summary)}
              </Text>
            </BlockStack>
            <Button onClick={() => onToggle(!summary.enabled)} accessibilityLabel={`${toggleLabel} ${meta.title.toLowerCase()}`}>
              {toggleLabel}
            </Button>
          </InlineStack>
          {serverError && (
            <Banner tone="critical">
              <Text as="p">{serverError}</Text>
            </Banner>
          )}
          {!summary.enabled && showBody && (
            <Banner tone="warning">
              <Text as="p">This section is off, but some of its entries need fixing before you can save.</Text>
            </Banner>
          )}
          {showBody && (
            <>
              <Divider />
              {children}
            </>
          )}
        </BlockStack>
      </Card>
    </Layout.AnnotatedSection>
  );
}

const MATCH_OPTIONS = [
  { label: "Address contains this text", value: "contains" },
  { label: "Advanced: address matches a pattern", value: "pattern" },
];

type AddressRuleEditorProps = {
  row: AddressRuleRow;
  index: number;
  errors?: Record<string, string>;
  countryOptions: Option[];
  onChange: (patch: Partial<AddressRuleRow>) => void;
  onRemove: () => void;
};

function AddressRuleEditor({ row, index, errors, countryOptions, onChange, onRemove }: AddressRuleEditorProps) {
  // Keep a country saved by an older version selectable even if it's not in the list.
  const options =
    row.country && !countryOptions.some((option) => option.value === row.country)
      ? [...countryOptions, { label: row.country, value: row.country }]
      : countryOptions;
  const isPattern = row.match === "pattern";
  return (
    <Box padding="400" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h4" variant="headingSm">
            Address {index + 1}
          </Text>
          <Button variant="plain" tone="critical" onClick={onRemove} accessibilityLabel={`Remove address ${index + 1}`}>
            Remove
          </Button>
        </InlineStack>
        <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="300">
          <Select label="Block when" options={MATCH_OPTIONS} value={row.match} onChange={(value) => onChange({ match: value as AddressMatch })} />
          <TextField
            label={isPattern ? "Pattern" : "Text to look for"}
            value={row.text}
            onChange={(text) => onChange({ text })}
            placeholder={isPattern ? "\\bunit\\s+\\d+" : "Calle 5, Avenida Central"}
            helpText={
              isPattern
                ? "For technical users: a regular expression, not case-sensitive."
                : "Checked against both address lines and the city. Capitals and accents don't matter."
            }
            monospaced={isPattern}
            error={errors?.text}
            autoComplete="off"
          />
        </InlineGrid>
        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <Select
            label="Only in this country"
            options={options}
            value={row.country}
            onChange={(country) => onChange({ country })}
            error={errors?.country}
          />
          <TextField
            label="Only in this city (optional)"
            value={row.city}
            onChange={(city) => onChange({ city })}
            placeholder="Leave blank for every city"
            error={errors?.city}
            autoComplete="off"
          />
        </InlineGrid>
        <TextField
          label="Message customers see (optional)"
          value={row.message}
          onChange={(message) => onChange({ message })}
          placeholder={DEFAULT_ADDRESS_MESSAGE}
          maxLength={MESSAGE_MAX_LENGTH}
          showCharacterCount
          autoComplete="off"
        />
      </BlockStack>
    </Box>
  );
}

const TARGET_OPTIONS = [
  { label: "Products with a tag", value: "tag" },
  { label: "One product", value: "product" },
  { label: "Every product", value: "all" },
];

type LimitEditorProps = {
  row: LimitRow;
  index: number;
  errors?: Record<string, string>;
  onChange: (patch: Partial<LimitRow>) => void;
  onRemove: () => void;
};

function LimitEditor({ row, index, errors, onChange, onRemove }: LimitEditorProps) {
  const everyProduct = row.target === "all";
  const max = Number(row.max);
  const exampleMax = Number.isInteger(max) && max > 0 ? formatNumber(max) : "10";
  return (
    <Box padding="400" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h4" variant="headingSm">
            Limit {index + 1}
          </Text>
          <Button variant="plain" tone="critical" onClick={onRemove} accessibilityLabel={`Remove limit ${index + 1}`}>
            Remove
          </Button>
        </InlineStack>
        <InlineGrid columns={{ xs: 1, md: everyProduct ? 2 : 3 }} gap="300">
          <Select label="Applies to" options={TARGET_OPTIONS} value={row.target} onChange={(value) => onChange({ target: value as LimitTarget })} />
          {!everyProduct && (
            <TextField
              label={row.target === "tag" ? "Product tag" : "Product ID"}
              value={row.value}
              onChange={(value) => onChange({ value })}
              placeholder={row.target === "tag" ? "limited-edition" : "8123456789"}
              helpText={row.target === "tag" ? "Exactly as it appears on your products." : "The number at the end of the product's page address."}
              error={errors?.value}
              autoComplete="off"
            />
          )}
          <TextField
            label="Most units per order"
            type="number"
            min={1}
            max={MAX_UNITS}
            step={1}
            value={row.max}
            onChange={(value) => onChange({ max: value })}
            placeholder="10"
            error={errors?.max}
            autoComplete="off"
          />
        </InlineGrid>
        <TextField
          label="Message customers see (optional)"
          value={row.message}
          onChange={(message) => onChange({ message })}
          placeholder={`You can buy up to ${exampleMax} of this item per order. Please reduce the quantity.`}
          maxLength={MESSAGE_MAX_LENGTH}
          showCharacterCount
          autoComplete="off"
        />
      </BlockStack>
    </Box>
  );
}

function ImpactSummary({ impact }: { impact: ImpactResult }) {
  if (impact.scanned === 0) {
    return <Text as="p">You don&apos;t have any orders to test against yet. These rules still apply to new checkouts.</Text>;
  }
  return (
    <BlockStack gap="200">
      <Text as="p" fontWeight="semibold">
        {impact.blocked === 0
          ? `None of your last ${formatNumber(impact.scanned)} orders would have been stopped.`
          : `${formatNumber(impact.blocked)} of your last ${formatNumber(impact.scanned)} orders (${formatShare(impact.blocked, impact.scanned)}) would have been stopped.`}
      </Text>
      {impact.samples.length > 0 && (
        <List>
          {impact.samples.map((sample, index) => (
            <List.Item key={`${index}-${sample}`}>{sample}</List.Item>
          ))}
        </List>
      )}
      <Text as="p" variant="bodySm" tone="subdued">
        Checks up to 40 products per order. Nothing was changed.
      </Text>
    </BlockStack>
  );
}

function ValidationStatusBanner({ status, onActivate, busy }: { status: ValidationStatus; onActivate: () => void; busy: boolean }) {
  if (status.state === "active") return null;
  if (status.state === "function_not_deployed") {
    return (
      <Banner tone="critical" title="CartGuard's checkout protection isn't installed yet">
        <Text as="p">
          This usually resolves within a few minutes of installing CartGuard. If it doesn&apos;t, reinstall the app or email support@cartguard.io. Until then, no checkout is blocked.
        </Text>
      </Banner>
    );
  }
  if (status.state === "unknown") {
    return (
      <Banner tone="warning" title="We couldn't check whether CartGuard is active at checkout" action={{ content: "Reload", onAction: () => window.location.reload() }}>
        <Text as="p">{status.message ?? "Try reloading the page in a moment."}</Text>
      </Banner>
    );
  }
  return (
    <Banner
      tone="warning"
      title="CartGuard isn't protecting checkout yet"
      action={{ content: busy ? "Saving…" : "Save and turn on", onAction: () => { if (!busy) onActivate(); } }}
    >
      <Text as="p">Save your rules to switch protection on. Until then, no checkout is blocked.</Text>
    </Banner>
  );
}

function jumpTo(section: RuleSection) {
  document.getElementById(SECTION_META[section].anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ── Page ───────────────────────────────────────────────────────────────────────── */

export default function BlockRulesPage() {
  const { config, validation, needsMigration } = useLoaderData<typeof loader>() as unknown as RulesState;
  const fetcher = useFetcher<ActionResponse>();
  const shopify = useAppBridge();

  // `saved` mirrors what is stored in Shopify; it only moves after a successful save.
  const [saved, setSaved] = useState<EditorState>(() => editorFromConfig(config));
  const [state, setState] = useState<EditorState>(saved);
  const [result, setResult] = useState<ActionResponse | null>(null);
  const [showFixList, setShowFixList] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<Intent | null>(null);
  const [cityCountry, setCityCountry] = useState("");
  const [zipCountry, setZipCountry] = useState("");
  const submittedState = useRef<EditorState | null>(null);

  const draft = useMemo(() => configFromEditor(state), [state]);
  const savedFingerprint = useMemo(() => JSON.stringify(configFromEditor(saved)), [saved]);
  const dirty = JSON.stringify(draft) !== savedFingerprint;
  const errors = useMemo(() => validateEditor(state), [state]);
  const summaries = useMemo(() => summarizeSections(draft), [draft]);
  const countryOptions = useMemo<Option[]>(() => [{ label: "Any country", value: "" }, ...getCountryOptions()], []);
  const busy = fetcher.state !== "idle";
  const needsActivation = validation.state !== "active" || needsMigration;
  const canSave = !busy && (dirty || needsActivation);

  const update = (patch: Partial<EditorState>) => setState((current) => ({ ...current, ...patch }));
  const setFlag = (flag: FeatureFlag, enabled: boolean) =>
    setState((current) => ({ ...current, settings: { ...current.settings, [flag]: enabled } }));
  const setCheck = (check: BuiltInCheck, enabled: boolean) =>
    setState((current) => ({ ...current, checks: { ...current.checks, [check]: enabled } }));
  const updateAddressRule = (id: string, patch: Partial<AddressRuleRow>) =>
    setState((current) => ({ ...current, addressRules: current.addressRules.map((row) => (row.id === id ? { ...row, ...patch } : row)) }));
  const removeAddressRule = (id: string) =>
    setState((current) => ({ ...current, addressRules: current.addressRules.filter((row) => row.id !== id) }));
  const updateLimit = (id: string, patch: Partial<LimitRow>) =>
    setState((current) => ({ ...current, limits: current.limits.map((row) => (row.id === id ? { ...row, ...patch } : row)) }));
  const removeLimit = (id: string) => setState((current) => ({ ...current, limits: current.limits.filter((row) => row.id !== id) }));

  // Refresh, tab close or leaving the app would silently drop edits.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Moving to another CartGuard page (nav menu, links) would drop edits too.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    // Saved or discarded since the navigation was blocked: nothing left to warn about.
    if (!dirty) blocker.reset?.();
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }, [blocker, dirty]);

  const submit = useCallback(
    (intent: Intent, confirmed = false) => {
      if (errors.total > 0) {
        setShowFixList(true);
        setResult(null);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      setShowFixList(false);
      setPendingIntent(intent);
      if (intent === "save") submittedState.current = state;
      // Round-trip through JSON so the payload is plain data (no undefined).
      const body = JSON.parse(JSON.stringify({ intent, confirmed, config: draft })) as Parameters<typeof fetcher.submit>[0];
      fetcher.submit(body, { method: "post", encType: "application/json" });
    },
    [errors.total, state, draft, fetcher],
  );

  useEffect(() => {
    const data = fetcher.data as ActionResponse | undefined;
    if (!data || fetcher.state !== "idle") return;
    setResult(data);
    setPendingIntent(null);
    if (data.saved) {
      if (submittedState.current) setSaved(submittedState.current);
      shopify?.toast?.show(data.validationWarning ? "Rules saved. Checkout protection needs attention." : "Rules saved. CartGuard is protecting checkout.");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [fetcher.data, fetcher.state, shopify]);

  const discard = () => {
    setState(saved);
    setResult(null);
    setShowFixList(false);
  };

  const serverErrors = result && !result.ok ? result.sectionErrors ?? {} : {};
  const listError = (id: string) => errors.fields[id]?.list;
  const saving = busy && pendingIntent === "save";
  const testing = busy && pendingIntent === "simulate";

  const primaryAction = { content: "Save", onAction: () => submit("save"), disabled: !canSave, loading: saving };
  const secondaryActions = [
    { content: "Test on recent orders", onAction: () => submit("simulate"), disabled: busy, loading: testing },
    ...(dirty ? [{ content: "Discard changes", onAction: discard, disabled: busy }] : []),
  ];

  return (
    <Page
      title="Block rules"
      subtitle="Choose which orders CartGuard stops at checkout."
      titleMetadata={dirty ? <Badge tone="attention">Unsaved changes</Badge> : undefined}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
    >
      <Layout>
        {blocker.state === "blocked" && (
          <Layout.Section>
            <Banner
              tone="warning"
              title="You have unsaved changes"
              action={{ content: "Stay and keep editing", onAction: () => blocker.reset?.() }}
              secondaryAction={{ content: "Leave without saving", onAction: () => blocker.proceed?.() }}
            >
              <Text as="p">If you leave this page now, your changes to the block rules will be lost.</Text>
            </Banner>
          </Layout.Section>
        )}

        {!result?.saved && validation.state !== "active" && (
          <Layout.Section>
            <ValidationStatusBanner status={validation} onActivate={() => submit("save")} busy={busy} />
          </Layout.Section>
        )}

        {needsMigration && !result?.saved && (
          <Layout.Section>
            <Banner tone="warning" title="Save once to apply these rules at checkout">
              <Text as="p">
                These rules were saved by an older version of CartGuard and aren&apos;t enforced at checkout yet. Review them and click Save.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {showFixList && errors.total > 0 && (
          <Layout.Section>
            <Banner
              tone="critical"
              title={`Fix ${pluralize(errors.total, "field")} before continuing`}
              onDismiss={() => setShowFixList(false)}
            >
              <List>
                {RULE_SECTIONS.filter((section) => errors.bySection[section] > 0).map((section) => (
                  <List.Item key={section}>
                    <Link onClick={() => jumpTo(section)}>{SECTION_META[section].title}</Link>: {pluralize(errors.bySection[section], "field")} to fix
                  </List.Item>
                ))}
              </List>
            </Banner>
          </Layout.Section>
        )}

        {result?.saved && !result.validationWarning && (
          <Layout.Section>
            <Banner tone="success" title="Rules saved and active at checkout" onDismiss={() => setResult(null)}>
              <Text as="p">CartGuard now checks every checkout with these rules.</Text>
            </Banner>
          </Layout.Section>
        )}

        {result?.saved && result.validationWarning && (
          <Layout.Section>
            <Banner tone="warning" title="Rules saved, but CartGuard couldn't be turned on at checkout" onDismiss={() => setResult(null)}>
              <BlockStack gap="200">
                <Text as="p">{result.validationWarning}</Text>
                <Text as="p">Fix the problem above and save again. Until then, checkout isn&apos;t protected.</Text>
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
              {result.impactError ? <Text as="p">{result.impactError}</Text> : result.impact ? <ImpactSummary impact={result.impact} /> : null}
            </Banner>
          </Layout.Section>
        )}

        {result?.ok && !result.saved && !result.needsConfirm && result.impact && (
          <Layout.Section>
            <Banner tone={result.impact.blocked > 0 ? "warning" : "success"} title="Test on recent orders" onDismiss={() => setResult(null)}>
              <ImpactSummary impact={result.impact} />
            </Banner>
          </Layout.Section>
        )}

        {result && !result.ok && (
          <Layout.Section>
            <Banner tone="critical" title={result.message ?? "Something went wrong"} onDismiss={() => setResult(null)}>
              {RULE_SECTIONS.some((section) => serverErrors[section]) && (
                <List>
                  {RULE_SECTIONS.filter((section) => serverErrors[section]).map((section) => (
                    <List.Item key={section}>
                      <Link onClick={() => jumpTo(section)}>{SECTION_META[section].title}</Link>: {serverErrors[section]}
                    </List.Item>
                  ))}
                </List>
              )}
            </Banner>
          </Layout.Section>
        )}

        {/* Countries and regions */}
        <RuleSectionCard
          section="geo"
          summary={summaries.geo}
          errorCount={errors.bySection.geo}
          serverError={serverErrors.geo}
          onToggle={(enabled) => setFlag(SECTION_META.geo.flag, enabled)}
        >
          <BlockStack gap="500">
            <CountryPicker
              label="Block orders shipping to these countries"
              helpText="This also applies to trusted customers."
              values={state.countries}
              onChange={(countries) => update({ countries })}
              error={listError(LIST_FIELD_IDS.countries)}
            />
            <RegionPicker
              label="Block orders shipping to these states or provinces"
              values={state.states}
              onChange={(states) => update({ states })}
              error={listError(LIST_FIELD_IDS.states)}
            />
            <ListField
              label="Block orders shipping to these cities"
              listName="blocked cities"
              helpText="Capitals, accents and punctuation don't matter. Separate several with commas."
              placeholder="San José"
              values={state.cities}
              onChange={(cities) => update({ cities })}
              parse={withCountryScope(parseCity, cityCountry)}
              format={describeScopedEntry}
              emptyText="No cities blocked."
              error={listError(LIST_FIELD_IDS.cities)}
              scope={<Select label="Country for new cities" labelHidden options={countryOptions} value={cityCountry} onChange={setCityCountry} />}
            />
            <ListField
              label="Block orders shipping to these postal codes"
              listName="blocked postal codes"
              helpText="Spaces and dashes don't matter, and US ZIP+4 codes match their 5-digit ZIP. Separate several with commas."
              placeholder="90210"
              values={state.zips}
              onChange={(zips) => update({ zips })}
              parse={withCountryScope(parseZip, zipCountry)}
              format={describeScopedEntry}
              emptyText="No postal codes blocked."
              error={listError(LIST_FIELD_IDS.zips)}
              scope={<Select label="Country for new postal codes" labelHidden options={countryOptions} value={zipCountry} onChange={setZipCountry} />}
            />
          </BlockStack>
        </RuleSectionCard>

        {/* Addresses */}
        <RuleSectionCard
          section="address"
          summary={summaries.address}
          errorCount={errors.bySection.address}
          serverError={serverErrors.address}
          onToggle={(enabled) => setFlag(SECTION_META.address.flag, enabled)}
        >
          <BlockStack gap="500">
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Common risky addresses
              </Text>
              <Checkbox
                label="Block PO Boxes"
                helpText="Catches P.O. Box, Post Office Box, Apartado Postal and Postfach, including common misspellings."
                checked={state.checks.po_box}
                onChange={(checked) => setCheck("po_box", checked)}
              />
              <Checkbox
                label="Block freight forwarders and reshipping services"
                helpText="Addresses that mention forwarding or reshipping, which are often used to hide the real destination."
                checked={state.checks.freight}
                onChange={(checked) => setCheck("freight", checked)}
              />
              <Checkbox
                label="Block US military addresses"
                helpText="APO, FPO and DPO addresses in the United States."
                checked={state.checks.military}
                onChange={(checked) => setCheck("military", checked)}
              />
            </BlockStack>
            <ListField
              label="Block addresses containing these words"
              listName="blocked words"
              helpText='For example "mail drop" or "warehouse 4B". Capitals and accents don&apos;t matter.'
              placeholder="mail drop"
              values={state.keywords}
              onChange={(keywords) => update({ keywords })}
              parse={parseKeyword}
              emptyText="No blocked words."
              error={listError(LIST_FIELD_IDS.keywords)}
            />
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">
                  Specific addresses
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Block one street or building, optionally only in one country or city, and choose what customers see.
                </Text>
              </BlockStack>
              {state.addressRules.length === 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  No specific addresses blocked.
                </Text>
              )}
              {state.addressRules.map((row, index) => (
                <AddressRuleEditor
                  key={row.id}
                  row={row}
                  index={index}
                  errors={errors.fields[row.id]}
                  countryOptions={countryOptions}
                  onChange={(patch) => updateAddressRule(row.id, patch)}
                  onRemove={() => removeAddressRule(row.id)}
                />
              ))}
              <InlineStack>
                <Button onClick={() => update({ addressRules: [...state.addressRules, newAddressRule()] })}>Add an address</Button>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </RuleSectionCard>

        {/* Order quantities */}
        <RuleSectionCard
          section="quantity"
          summary={summaries.quantity}
          errorCount={errors.bySection.quantity}
          serverError={serverErrors.quantity}
          onToggle={(enabled) => setFlag(SECTION_META.quantity.flag, enabled)}
        >
          <BlockStack gap="300">
            {state.limits.length === 0 && (
              <Text as="p" variant="bodySm" tone="subdued">
                No limits yet. Add one to cap how many units a customer can buy in one order.
              </Text>
            )}
            {state.limits.map((row, index) => (
              <LimitEditor
                key={row.id}
                row={row}
                index={index}
                errors={errors.fields[row.id]}
                onChange={(patch) => updateLimit(row.id, patch)}
                onRemove={() => removeLimit(row.id)}
              />
            ))}
            <InlineStack>
              <Button onClick={() => update({ limits: [...state.limits, newLimit()] })}>Add a limit</Button>
            </InlineStack>
          </BlockStack>
        </RuleSectionCard>

        {/* Trusted customers */}
        <RuleSectionCard
          section="vip"
          summary={summaries.vip}
          errorCount={errors.bySection.vip}
          serverError={serverErrors.vip}
          onToggle={(enabled) => setFlag(SECTION_META.vip.flag, enabled)}
        >
          <BlockStack gap="500">
            <ListField
              label="Trusted customer emails"
              listName="trusted emails"
              helpText="Customers signed in with these account emails skip every rule except blocked countries. Guests who just type the email don't."
              placeholder="customer@example.com"
              values={state.vipEmails}
              onChange={(vipEmails) => update({ vipEmails })}
              parse={parseVipEmail}
              emptyText="No trusted emails."
              error={listError(LIST_FIELD_IDS.vipEmails)}
            />
            <ListField
              label="Trusted street addresses"
              listName="trusted addresses"
              helpText="Must match address line 1 exactly. Only skips the address checks, not quantity limits or blocked areas."
              placeholder="123 Executive Blvd"
              values={state.vipAddresses}
              onChange={(vipAddresses) => update({ vipAddresses })}
              parse={parseVipAddress}
              allowMany={false}
              emptyText="No trusted addresses."
              error={listError(LIST_FIELD_IDS.vipAddresses)}
            />
          </BlockStack>
        </RuleSectionCard>

        <Layout.Section>
          <PageActions primaryAction={primaryAction} secondaryActions={secondaryActions} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}

/**
 * Shown when the loader fails (Shopify down, timeout, API error). Auth
 * responses still go through the Shopify boundary so re-auth works.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  return (
    <Page title="Block rules">
      <Banner
        tone="critical"
        title="CartGuard couldn't load your rules"
        action={{ content: "Try again", onAction: () => window.location.reload() }}
      >
        <Text as="p">
          Shopify didn&apos;t respond or returned an error. Your rules haven&apos;t changed and checkout keeps working. Try again in a moment. If this keeps happening, email support@cartguard.io.
        </Text>
      </Banner>
    </Page>
  );
}
