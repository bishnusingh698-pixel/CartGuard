/**
 * CartFence block rules (Remix + Polaris).
 *
 * - Every rule is built with form controls. Merchants never see code or raw
 *   data; the form state lives in app/lib/rule-editor.ts.
 * - Rules are stored in app-owned shop metafields ($app:cartguard, json).
 * - Saving also makes sure CartFence's checkout rule (a Shopify Validation
 *   running the cartfence-validator Function) exists and is enabled.
 * - "Test on recent orders" simulates the rules on recent orders with the
 *   same rule engine the checkout Function uses.
 * - The page opens with a three-step guide, links to every section and
 *   ready-made templates, and ends with "Try a checkout", which runs the
 *   unsaved rules on an address and email the merchant types.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isRouteErrorResponse, useBlocker, useFetcher, useLoaderData, useRouteError } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "../lib/cartfence.server";
import { type RulesState, getAdmin, loadRulesState } from "../lib/dashboard.server";
import { type ValidationStatus } from "../lib/validation.server";
import { CountryPicker, ListField, RegionPicker } from "../components/rule-fields";
import { CheckoutTester } from "../components/checkout-tester";
import { RULE_TEMPLATES, TEMPLATE_SECTION, applyTemplate, templateApplied, type RuleTemplate } from "../lib/rule-templates";
import { SectionBadge, useSectionStatusText } from "../components/section-status";
import { describeScopedEntry, getCountryOptions, type Option } from "../lib/regions";
import {
  LIST_FIELD_IDS,
  MAX_ORDER_AMOUNT,
  MAX_UNITS,
  MESSAGE_MAX_LENGTH,
  configFromEditor,
  editorFromConfig,
  newAddressRule,
  newLimit,
  newProductRule,
  parseCity,
  parseCustomerTag,
  parseEmailDomain,
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
  type ProductRuleRow,
} from "../lib/rule-editor";
import { useI18n } from "../i18n/context";
import {
  RULE_SECTIONS,
  SECTION_META,
  SECTION_DESCRIPTION_KEY,
  SECTION_TITLE_KEY,
  type RuleSection,
  type SectionSummary,
  formatShare,
  hiddenDataMessageKey,
  summarizeSections,
} from "../lib/rule-summary";
import {
  DEFAULT_ADDRESS_MESSAGE,
  DEFAULT_EMAIL_MESSAGE,
  DEFAULT_PRODUCT_COUNTRY_MESSAGE,
  DISPOSABLE_EMAIL_DOMAINS,
  isRecord,
  type FeatureFlag,
} from "../../extensions/cartfence-validator/src/rules";

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

/* Loader */

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, isDemo } = await getAdmin(request);
  return json<RulesState>(await loadRulesState(admin, isDemo));
}

/* Action */

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
        console.warn("[CartFence] Impact check failed before save:", errorMessage(error));
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
    console.error("[CartFence] Rules action failed:", error);
    return json<ActionResponse>(
      {
        ok: false,
        message: `${intent === "simulate" ? "The test didn't finish." : "Your rules weren't saved."} ${friendlyErrorMessage(error)}`,
      },
      { status: 500 },
    );
  }
}

/* Presentational pieces */

type RuleSectionCardProps = {
  section: RuleSection;
  summary: SectionSummary;
  errorCount: number;
  serverError?: string;
  onToggle: (enabled: boolean) => void;
  children: ReactNode;
};

function RuleSectionCard({ section, summary, errorCount, serverError, onToggle, children }: RuleSectionCardProps) {
  const { t } = useI18n();
  const meta = SECTION_META[section];
  // Entries stay saved while a section is off. If they need fixing, show them
  // anyway so a hidden problem can never block saving.
  const showBody = summary.enabled || errorCount > 0 || Boolean(serverError);
  const toggleLabel = summary.enabled ? t("section.turnOff") : t("section.turnOn");
  return (
    <Layout.AnnotatedSection id={meta.anchor} title={t(SECTION_TITLE_KEY[section])} description={t(SECTION_DESCRIPTION_KEY[section])}>
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="100">
              <InlineStack>
                <SectionBadge summary={summary} />
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                {useSectionStatusText(summary)}
              </Text>
            </BlockStack>
            <Button onClick={() => onToggle(!summary.enabled)} accessibilityLabel={`${toggleLabel}: ${t(SECTION_TITLE_KEY[section])}`}>
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
              <Text as="p">{t("section.offButInvalid.title")}</Text>
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

type TFn = ReturnType<typeof useI18n>["t"];

function matchOptions(t: TFn) {
  return [
    { label: t("address.match.contains"), value: "contains" },
    { label: t("address.match.pattern"), value: "pattern" },
  ];
}

type AddressRuleEditorProps = {
  row: AddressRuleRow;
  index: number;
  errors?: Record<string, string>;
  countryOptions: Option[];
  onChange: (patch: Partial<AddressRuleRow>) => void;
  onRemove: () => void;
};

function AddressRuleEditor({ row, index, errors, countryOptions, onChange, onRemove }: AddressRuleEditorProps) {
  const { t, number } = useI18n();
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
          <Button variant="plain" tone="critical" onClick={onRemove} accessibilityLabel={t("address.row.remove", { index: number(index + 1) })}>
            {t("common.remove")}
          </Button>
        </InlineStack>
        <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="300">
          <Select label={t("address.blockWhen")} options={matchOptions(t)} value={row.match} onChange={(value) => onChange({ match: value as AddressMatch })} />
          <TextField
            label={isPattern ? t("address.patternLabel") : t("address.textLabel")}
            value={row.text}
            onChange={(text) => onChange({ text })}
            placeholder={isPattern ? t("address.patternPlaceholder") : t("address.textPlaceholder")}
            helpText={
              isPattern ? t("address.patternHelp") : t("address.textHelp")
            }
            monospaced={isPattern}
            error={errors?.text}
            autoComplete="off"
          />
        </InlineGrid>
        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <Select
            label={t("address.countryLabel")}
            options={options}
            value={row.country}
            onChange={(country) => onChange({ country })}
            error={errors?.country}
          />
          <TextField
            label={t("address.cityLabel")}
            value={row.city}
            onChange={(city) => onChange({ city })}
            placeholder={t("address.cityPlaceholder")}
            error={errors?.city}
            autoComplete="off"
          />
        </InlineGrid>
        <TextField
          label={t("address.messageLabel")}
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

function targetOptions(t: TFn) {
  return [
    { label: t("quantity.target.tag"), value: "tag" },
    { label: t("quantity.target.product"), value: "product" },
    { label: t("quantity.target.all"), value: "all" },
  ];
}

type LimitEditorProps = {
  row: LimitRow;
  index: number;
  errors?: Record<string, string>;
  onChange: (patch: Partial<LimitRow>) => void;
  onRemove: () => void;
};

function LimitEditor({ row, index, errors, onChange, onRemove }: LimitEditorProps) {
  const { t, number } = useI18n();
  const everyProduct = row.target === "all";
  const max = Number(row.max);
  const exampleMax = Number.isInteger(max) && max > 0 ? number(max) : "10";
  return (
    <Box padding="400" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h4" variant="headingSm">
            {t("quantity.row.title", { index: number(index + 1) })}
          </Text>
          <Button variant="plain" tone="critical" onClick={onRemove} accessibilityLabel={t("quantity.row.remove", { index: number(index + 1) })}>
            {t("common.remove")}
          </Button>
        </InlineStack>
        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <Select
            label={t("quantity.appliesTo")}
            options={targetOptions(t)}
            value={row.target}
            onChange={(value) => onChange({ target: value as LimitTarget })}
            helpText={everyProduct ? t("quantity.allHelp") : undefined}
          />
          {!everyProduct && (
            <TextField
              label={row.target === "tag" ? t("quantity.tagLabel") : t("quantity.productLabel")}
              value={row.value}
              onChange={(value) => onChange({ value })}
              placeholder={row.target === "tag" ? t("quantity.placeholderTag") : t("quantity.placeholderProduct")}
              helpText={row.target === "tag" ? t("quantity.placeholderTagHelp") : t("quantity.placeholderProductHelp")}
              error={errors?.value}
              autoComplete="off"
            />
          )}
        </InlineGrid>
        {everyProduct && (
          <Text as="h5" variant="headingXs" tone="subdued">
            {t("quantity.perProduct")}
          </Text>
        )}
        <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
          <TextField
            label={everyProduct ? t("quantity.minUnitsEach") : t("quantity.minUnits")}
            type="number"
            min={0}
            max={MAX_UNITS}
            step={1}
            value={row.min}
            onChange={(value) => onChange({ min: value })}
            helpText={t("quantity.placeholderMin")}
            error={errors?.min}
            autoComplete="off"
          />
          <TextField
            label={everyProduct ? t("quantity.maxUnitsEach") : t("quantity.maxUnits")}
            type="number"
            min={0}
            max={MAX_UNITS}
            step={1}
            value={row.max}
            onChange={(value) => onChange({ max: value })}
            helpText={t("quantity.placeholderMax")}
            error={errors?.max}
            autoComplete="off"
          />
          <TextField
            label={t("quantity.multiple")}
            type="number"
            min={2}
            max={MAX_UNITS}
            step={1}
            value={row.multiple}
            onChange={(value) => onChange({ multiple: value })}
            helpText={t("quantity.multipleHelp")}
            error={errors?.multiple}
            autoComplete="off"
          />
        </InlineGrid>
        {everyProduct && (
          <Text as="h5" variant="headingXs" tone="subdued">
            {t("quantity.wholeOrder")}
          </Text>
        )}
        {everyProduct && (
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
            <TextField
              label={t("quantity.minItems")}
              type="number"
              min={1}
              max={MAX_UNITS}
              step={1}
              value={row.minItems}
              onChange={(value) => onChange({ minItems: value })}
              placeholder={t("quantity.placeholderMin")}
              helpText={t("quantity.itemsHelp")}
              error={errors?.minItems}
              autoComplete="off"
            />
            <TextField
              label={t("quantity.maxItems")}
              type="number"
              min={1}
              max={MAX_UNITS}
              step={1}
              value={row.maxItems}
              onChange={(value) => onChange({ maxItems: value })}
              placeholder={t("quantity.placeholderMax")}
              helpText={t("quantity.itemsHelp")}
              error={errors?.maxItems}
              autoComplete="off"
            />
          </InlineGrid>
        )}
        {everyProduct && (
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
            <TextField
              label={t("quantity.minAmount")}
              type="number"
              min={0}
              max={MAX_ORDER_AMOUNT}
              step={0.01}
              value={row.minAmount}
              onChange={(value) => onChange({ minAmount: value })}
              placeholder={t("quantity.placeholderMin")}
              helpText={t("quantity.currencyHelp")}
              error={errors?.minAmount}
              autoComplete="off"
            />
            <TextField
              label={t("quantity.maxAmount")}
              type="number"
              min={0}
              max={MAX_ORDER_AMOUNT}
              step={0.01}
              value={row.maxAmount}
              onChange={(value) => onChange({ maxAmount: value })}
              placeholder={t("quantity.placeholderMax")}
              helpText={t("quantity.currencyHelp")}
              error={errors?.maxAmount}
              autoComplete="off"
            />
          </InlineGrid>
        )}
        <TextField
          label={t("quantity.messageLabel")}
          value={row.message}
          onChange={(message) => onChange({ message })}
          placeholder={t("quantity.autoMessageReduceUnits", { count: exampleMax })}
          helpText={everyProduct ? t("quantity.messageHelpAll") : undefined}
          maxLength={MESSAGE_MAX_LENGTH}
          showCharacterCount
          autoComplete="off"
          error={errors?.message}
        />
      </BlockStack>
    </Box>
  );
}

type ProductRuleEditorProps = {
  row: ProductRuleRow;
  index: number;
  errors?: Record<string, string>;
  onChange: (patch: Partial<ProductRuleRow>) => void;
  onRemove: () => void;
};

function ProductRuleEditor({ row, index, errors, onChange, onRemove }: ProductRuleEditorProps) {
  const { t, number } = useI18n();
  return (
    <Box padding="400" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h4" variant="headingSm">
            {t("products.row.title", { index: number(index + 1) })}
          </Text>
          <Button variant="plain" tone="critical" onClick={onRemove} accessibilityLabel={t("products.row.remove", { index: number(index + 1) })}>
            {t("common.remove")}
          </Button>
        </InlineStack>
        <Box maxWidth="360px">
          <TextField
            label={t("quantity.tagLabel")}
            value={row.tag}
            onChange={(tag) => onChange({ tag })}
            placeholder={t("products.tagPlaceholder")}
            helpText={t("quantity.placeholderTagHelp")}
            error={errors?.tag}
            autoComplete="off"
          />
        </Box>
        <CountryPicker
          label={t("products.countriesLabel")}
          values={row.countries}
          onChange={(countries) => onChange({ countries })}
          error={errors?.countries}
          emptyText={t("products.countriesEmpty")}
        />
        <TextField
          label={t("quantity.messageLabel")}
          value={row.message}
          onChange={(message) => onChange({ message })}
          placeholder={DEFAULT_PRODUCT_COUNTRY_MESSAGE}
          maxLength={MESSAGE_MAX_LENGTH}
          showCharacterCount
          autoComplete="off"
          error={errors?.message}
        />
      </BlockStack>
    </Box>
  );
}

function ImpactSummary({ impact }: { impact: ImpactResult }) {
  const { t, number } = useI18n();
  if (impact.scanned === 0) {
    return <Text as="p">{t("impact.noOrdersToTest")}</Text>;
  }
  return (
    <BlockStack gap="200">
      <Text as="p" fontWeight="semibold">
        {impact.blocked === 0
          ? t("impact.clean", { count: number(impact.scanned) })
          : t("impact.blockedOf", {
              blocked: number(impact.blocked),
              total: number(impact.scanned),
              share: formatShare(impact.blocked, impact.scanned),
            })}
      </Text>
      {impact.samples.length > 0 && (
        <List>
          {impact.samples.map((sample, index) => (
            <List.Item key={`${index}-${sample}`}>{sample}</List.Item>
          ))}
        </List>
      )}
      {impact.customerDataHidden && (
        <Text as="p" variant="bodySm" tone="caution">
          {t(hiddenDataMessageKey(impact.hiddenFields))}
        </Text>
      )}
      <Text as="p" variant="bodySm" tone="subdued">
        {t("rules.impactLimited")}
      </Text>
    </BlockStack>
  );
}

function ValidationStatusBanner({ status, onActivate, busy }: { status: ValidationStatus; onActivate: () => void; busy: boolean }) {
  const { t } = useI18n();
  if (status.state === "active") return null;
  if (status.state === "function_not_deployed") {
    return (
      <Banner tone="critical" title={t("rules.validationMissing.title")}>
        <Text as="p">
          {t("rules.validationMissing.body")}
        </Text>
      </Banner>
    );
  }
  if (status.state === "unknown") {
    return (
      <Banner
        tone="warning"
        title={t("rules.validationUnknown.title")}
        action={{ content: t("common.reload"), onAction: () => window.location.reload() }}
      >
        <Text as="p">{status.message ?? t("rules.validationUnknown.body")}</Text>
      </Banner>
    );
  }
  return (
    <Banner
      tone="warning"
      title={t("rules.notActive.title")}
      action={{
        content: busy ? t("rules.confirm.saving") : t("rules.notActive.saveAndTurnOn"),
        onAction: () => {
          if (!busy) onActivate();
        },
      }}
    >
      <Text as="p">{t("rules.notActive.body")}</Text>
    </Banner>
  );
}

/**
 * `rules.fixList.item` is "{section}: {count} to fix", where the section title is
 * itself a clickable link. Rendering the placeholder as a string would lose the
 * anchor, so the sentence is split around it and the title is spliced in as an
 * element, letting translators keep their own word order.
 */
const SECTION_SLOT = String.fromCharCode(0);

function FixListRow({ section, count, onJump }: { section: RuleSection; count: number; onJump: () => void }) {
  const { t } = useI18n();
  const title = t(SECTION_TITLE_KEY[section]);
  const parts = t("rules.fixList.item", { section: SECTION_SLOT, count }).split(SECTION_SLOT);
  return (
    <>
      {parts.map((part, index) =>
        part === "" && parts.length > 1 ? (
          <Link key={index} onClick={onJump} removeUnderline>
            {title}
          </Link>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

const TESTER_ANCHOR = "try-a-checkout";

function jumpToAnchor(anchor: string) {
  document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function jumpTo(section: RuleSection) {
  jumpToAnchor(SECTION_META[section].anchor);
}

/* Getting around */

const GUIDE_STEPS = ["rules.guide.step1", "rules.guide.step2", "rules.guide.step3"] as const;

/**
 * The top of the page: what to do in three steps, and a button per section
 * that shows its status and scrolls to it. The page is long, so this is the
 * map that keeps merchants from scrolling to find things.
 */
function RulesGuide({ summaries, errors }: { summaries: Record<RuleSection, SectionSummary>; errors: Record<RuleSection, number> }) {
  const { t, number } = useI18n();
  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            {t("rules.guide.title")}
          </Text>
          <List type="number">
            {GUIDE_STEPS.map((step) => (
              <List.Item key={step}>{t(step)}</List.Item>
            ))}
          </List>
        </BlockStack>
        <Divider />
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            {t("rules.guide.jump")}
          </Text>
          <nav aria-label={t("rules.guide.jump")}>
            <InlineGrid columns={{ xs: 1, sm: 2, lg: 3 }} gap="200">
              {[...RULE_SECTIONS, "tester" as const].map((section) => {
                const isTester = section === "tester";
                const title = isTester ? t("tester.title") : t(SECTION_TITLE_KEY[section]);
                return (
                  <Box key={section} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                    <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
                      <Link removeUnderline onClick={() => jumpToAnchor(isTester ? TESTER_ANCHOR : SECTION_META[section].anchor)}>
                        {title}
                      </Link>
                      {!isTester && errors[section] > 0 ? (
                        <Badge tone="critical">{t("rules.guide.toFix", { count: number(errors[section]) })}</Badge>
                      ) : !isTester ? (
                        <SectionBadge summary={summaries[section]} />
                      ) : null}
                    </InlineStack>
                  </Box>
                );
              })}
            </InlineGrid>
          </nav>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function RuleTemplates({ state, onApply }: { state: EditorState; onApply: (template: RuleTemplate) => void }) {
  const { t } = useI18n();
  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            {t("templates.title")}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {t("templates.description")}
          </Text>
        </BlockStack>
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          {RULE_TEMPLATES.map((template) => {
            const applied = templateApplied(state, template);
            return (
              <Box key={template} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    {t(`templates.${template}.title`)}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t(`templates.${template}.body`)}
                  </Text>
                  <InlineStack>
                    {applied ? (
                      <Badge tone="success">{t("templates.added")}</Badge>
                    ) : (
                      <Button
                        size="slim"
                        onClick={() => onApply(template)}
                        accessibilityLabel={`${t("templates.use")}: ${t(`templates.${template}.title`)}`}
                      >
                        {t("templates.use")}
                      </Button>
                    )}
                  </InlineStack>
                </BlockStack>
              </Box>
            );
          })}
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

/* Page */

export default function BlockRulesPage() {
  const { t, number, language } = useI18n();
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
  const summaries = useMemo(() => summarizeSections(draft, language), [draft, language]);
  const countryOptions = useMemo<Option[]>(
    () => [{ label: t("fields.countries.anyCountry"), value: "" }, ...getCountryOptions(language)],
    [language, t],
  );
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
  const updateProductRule = (id: string, patch: Partial<ProductRuleRow>) =>
    setState((current) => ({ ...current, productRules: current.productRules.map((row) => (row.id === id ? { ...row, ...patch } : row)) }));
  const removeProductRule = (id: string) =>
    setState((current) => ({ ...current, productRules: current.productRules.filter((row) => row.id !== id) }));

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

  // Moving to another CartFence page (nav menu, links) would drop edits too.
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
      shopify?.toast?.show(data.validationWarning ? "Rules saved. Checkout protection needs attention." : "Rules saved. CartFence is protecting checkout.");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [fetcher.data, fetcher.state, shopify]);

  const applyTemplateToForm = (template: RuleTemplate) => {
    setState((current) => applyTemplate(current, template));
    shopify?.toast?.show(t("templates.appliedToast"));
    // Let the section open before scrolling to it.
    window.setTimeout(() => jumpTo(TEMPLATE_SECTION[template]), 50);
  };

  const discard = () => {
    setState(saved);
    setResult(null);
    setShowFixList(false);
  };

  const serverErrors = result && !result.ok ? result.sectionErrors ?? {} : {};
  const listError = (id: string) => errors.fields[id]?.list;
  const saving = busy && pendingIntent === "save";
  const testing = busy && pendingIntent === "simulate";

  const primaryAction = { content: t("common.save"), onAction: () => submit("save"), disabled: !canSave, loading: saving };
  const secondaryActions = [
    { content: t("rules.test"), onAction: () => submit("simulate"), disabled: busy, loading: testing },
    ...(dirty ? [{ content: t("rules.discard"), onAction: discard, disabled: busy }] : []),
  ];

  return (
    <Page
      title={t("rules.title")}
      subtitle={t("rules.subtitle")}
      titleMetadata={dirty ? <Badge tone="attention">{t("rules.unsaved")}</Badge> : undefined}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
    >
      <Layout>
        {blocker.state === "blocked" && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={t("rules.blocker.title")}
              action={{ content: t("rules.blocker.stay"), onAction: () => blocker.reset?.() }}
              secondaryAction={{ content: t("rules.blocker.leave"), onAction: () => blocker.proceed?.() }}
            >
              <Text as="p">{t("rules.blocker.body")}</Text>
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
            <Banner tone="warning" title={t("rules.migration.title")}>
              <Text as="p">{t("rules.migration.body")}</Text>
            </Banner>
          </Layout.Section>
        )}

        {showFixList && errors.total > 0 && (
          <Layout.Section>
            <Banner
              tone="critical"
              title={t("rules.fixList.title", { count: number(errors.total) })}
              onDismiss={() => setShowFixList(false)}
            >
              <List>
                {RULE_SECTIONS.filter((section) => errors.bySection[section] > 0).map((section) => (
                  <List.Item key={section}>
                    <FixListRow section={section} count={errors.bySection[section]} onJump={() => jumpTo(section)} />
                  </List.Item>
                ))}
              </List>
            </Banner>
          </Layout.Section>
        )}

        {result?.saved && !result.validationWarning && (
          <Layout.Section>
            <Banner
              tone="success"
              title={t("rules.savedBanner.title")}
              action={{ content: t("rules.savedBanner.next"), url: "/app/orders" }}
              onDismiss={() => setResult(null)}
            >
              <Text as="p">{t("rules.savedBanner.body")}</Text>
            </Banner>
          </Layout.Section>
        )}

        {result?.saved && result.validationWarning && (
          <Layout.Section>
            <Banner tone="warning" title={t("rules.warningBanner.title")} onDismiss={() => setResult(null)}>
              <BlockStack gap="200">
                <Text as="p">{result.validationWarning}</Text>
                <Text as="p">{t("rules.warningBanner.hint")}</Text>
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}

        {result?.needsConfirm && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={t("rules.confirm.title")}
              action={{
                content: busy ? t("rules.confirm.saving") : t("rules.confirm.save"),
                onAction: () => {
                  if (!busy) submit("save", true);
                },
              }}
              secondaryAction={{ content: t("common.cancel"), onAction: () => setResult(null) }}
              onDismiss={() => setResult(null)}
            >
              {result.impactError ? <Text as="p">{result.impactError}</Text> : result.impact ? <ImpactSummary impact={result.impact} /> : null}
            </Banner>
          </Layout.Section>
        )}

        {result?.ok && !result.saved && !result.needsConfirm && result.impact && (
          <Layout.Section>
            <Banner tone={result.impact.blocked > 0 ? "warning" : "success"} title={t("rules.impactTested.title")} onDismiss={() => setResult(null)}>
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
                      <Link onClick={() => jumpTo(section)}>{t(SECTION_TITLE_KEY[section])}</Link>: {serverErrors[section]}
                    </List.Item>
                  ))}
                </List>
              )}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <BlockStack gap="400">
            <RulesGuide summaries={summaries} errors={errors.bySection} />
            {RULE_TEMPLATES.some((template) => !templateApplied(state, template)) && <RuleTemplates state={state} onApply={applyTemplateToForm} />}
          </BlockStack>
        </Layout.Section>

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
              label={t("fields.countries.label")}
              helpText={t("fields.countries.help")}
              values={state.countries}
              onChange={(countries) => update({ countries })}
              error={listError(LIST_FIELD_IDS.countries)}
            />
            <RegionPicker
              label={t("fields.states.label")}
              values={state.states}
              onChange={(states) => update({ states })}
              error={listError(LIST_FIELD_IDS.states)}
            />
            <ListField
              label={t("fields.cities.label")}
              listName="blocked cities"
              helpText={t("fields.cities.help")}
              placeholder={t("fields.cities.placeholder")}
              values={state.cities}
              onChange={(cities) => update({ cities })}
              parse={withCountryScope(parseCity, cityCountry)}
              format={describeScopedEntry}
              emptyText={t("fields.cities.empty")}
              error={listError(LIST_FIELD_IDS.cities)}
              scope={<Select label={t("fields.cities.scope")} labelHidden options={countryOptions} value={cityCountry} onChange={setCityCountry} />}
            />
            <ListField
              label={t("fields.zips.label")}
              listName="blocked postal codes"
              helpText={t("fields.zips.help")}
              placeholder="90210"
              values={state.zips}
              onChange={(zips) => update({ zips })}
              parse={withCountryScope(parseZip, zipCountry)}
              format={describeScopedEntry}
              emptyText={t("fields.zips.empty")}
              error={listError(LIST_FIELD_IDS.zips)}
              scope={<Select label={t("fields.zips.scope")} labelHidden options={countryOptions} value={zipCountry} onChange={setZipCountry} />}
            />
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">
                  {t("products.title")}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {t("products.description")}
                </Text>
              </BlockStack>
              {errors.fields["geo.products"]?.list && (
                <Text as="p" tone="critical">
                  {errors.fields["geo.products"].list}
                </Text>
              )}
              {state.productRules.length === 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {t("products.empty")}
                </Text>
              )}
              {state.productRules.map((row, index) => (
                <ProductRuleEditor
                  key={row.id}
                  row={row}
                  index={index}
                  errors={errors.fields[row.id]}
                  onChange={(patch) => updateProductRule(row.id, patch)}
                  onRemove={() => removeProductRule(row.id)}
                />
              ))}
              <InlineStack>
                <Button onClick={() => update({ productRules: [...state.productRules, newProductRule()] })}>{t("products.add")}</Button>
              </InlineStack>
            </BlockStack>
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
                label={t("address.poBox.label")}
                helpText={t("address.poBox.help")}
                checked={state.checks.po_box}
                onChange={(checked) => setCheck("po_box", checked)}
              />
              <Checkbox
                label={t("address.military.label")}
                helpText={t("address.military.help")}
                checked={state.checks.military}
                onChange={(checked) => setCheck("military", checked)}
              />
              <Checkbox
                label={t("address.houseNumber.label")}
                helpText={t("address.houseNumber.help")}
                checked={state.checks.house_number}
                onChange={(checked) => setCheck("house_number", checked)}
              />
              {state.checks.house_number && (
                <Box paddingInlineStart="600" maxWidth="360px">
                  <Select
                    label={t("address.houseNumber.country")}
                    options={countryOptions}
                    value={state.houseNumberCountry}
                    onChange={(houseNumberCountry) => update({ houseNumberCountry })}
                    error={errors.fields["address.houseNumber"]?.country}
                  />
                </Box>
              )}
            </BlockStack>
            <ListField
              label={t("fields.keywords.label")}
              listName="blocked words"
              helpText='For example "mail drop" or "warehouse 4B". Capitals and accents don&apos;t matter.'
              placeholder="mail drop"
              values={state.keywords}
              onChange={(keywords) => update({ keywords })}
              parse={parseKeyword}
              emptyText={t("fields.keywords.empty")}
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
                <Button onClick={() => update({ addressRules: [...state.addressRules, newAddressRule()] })}>{t("address.specific.add")}</Button>
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
              <Button onClick={() => update({ limits: [...state.limits, newLimit()] })}>{t("quantity.add")}</Button>
            </InlineStack>
          </BlockStack>
        </RuleSectionCard>

        {/* Email addresses */}
        <RuleSectionCard
          section="email"
          summary={summaries.email}
          errorCount={errors.bySection.email}
          serverError={serverErrors.email}
          onToggle={(enabled) => setFlag(SECTION_META.email.flag, enabled)}
        >
          <BlockStack gap="500">
            <Checkbox
              label={t("email.disposable.label")}
              helpText={t("email.disposable.help", { count: number(DISPOSABLE_EMAIL_DOMAINS.length) })}
              checked={state.blockDisposable}
              onChange={(blockDisposable) => update({ blockDisposable })}
            />
            <ListField
              label={t("fields.emailDomains.label")}
              listName="blocked email domains"
              helpText={t("fields.emailDomains.help")}
              placeholder="example.com"
              values={state.emailDomains}
              onChange={(emailDomains) => update({ emailDomains })}
              parse={parseEmailDomain}
              emptyText={t("fields.emailDomains.empty")}
              error={listError(LIST_FIELD_IDS.emailDomains)}
            />
            <TextField
              label={t("email.messageLabel")}
              value={state.emailMessage}
              onChange={(emailMessage) => update({ emailMessage })}
              placeholder={DEFAULT_EMAIL_MESSAGE}
              maxLength={MESSAGE_MAX_LENGTH}
              showCharacterCount
              autoComplete="off"
              error={errors.fields["email.message"]?.message}
            />
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
              label={t("fields.vipEmails.label")}
              listName="trusted emails"
              helpText={t("fields.vipEmails.help")}
              placeholder="customer@example.com"
              values={state.vipEmails}
              onChange={(vipEmails) => update({ vipEmails })}
              parse={parseVipEmail}
              emptyText={t("fields.vipEmails.empty")}
              error={listError(LIST_FIELD_IDS.vipEmails)}
            />
            <ListField
              label={t("fields.vipAddresses.label")}
              listName="trusted addresses"
              helpText={t("fields.vipAddresses.help")}
              placeholder="123 Executive Blvd"
              values={state.vipAddresses}
              onChange={(vipAddresses) => update({ vipAddresses })}
              parse={parseVipAddress}
              allowMany={false}
              emptyText={t("fields.vipAddresses.empty")}
              error={listError(LIST_FIELD_IDS.vipAddresses)}
            />
            <ListField
              label={t("fields.vipTags.label")}
              listName="trusted customer tags"
              helpText={t("fields.vipTags.help")}
              placeholder="wholesale"
              values={state.vipTags}
              onChange={(vipTags) => update({ vipTags })}
              parse={parseCustomerTag}
              emptyText={t("fields.vipTags.empty")}
              error={listError(LIST_FIELD_IDS.vipTags)}
            />
          </BlockStack>
        </RuleSectionCard>

        <Layout.AnnotatedSection id={TESTER_ANCHOR} title={t("tester.title")} description={t("tester.description")}>
          <Card>
            <CheckoutTester config={draft} countryOptions={countryOptions} />
          </Card>
        </Layout.AnnotatedSection>

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
  const { t } = useI18n();
  const error = useRouteError();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  return (
    <Page title={t("rules.title")}>
      <Banner
        tone="critical"
        title={t("errors.failedToLoadRules")}
        action={{ content: t("common.tryAgain"), onAction: () => window.location.reload() }}
      >
        <Text as="p">{t("common.shopifyUnresponsive")}</Text>
      </Banner>
    </Page>
  );
}
