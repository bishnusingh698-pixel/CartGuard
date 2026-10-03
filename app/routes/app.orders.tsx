/**
 * Order check: runs the saved block rules on recent orders and lists every
 * order they would have stopped. Shopify doesn't report blocked checkouts to
 * apps, so this is a test on real orders, not a history of blocks.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isRouteErrorResponse, useFetcher, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  DataTable,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  Page,
  SkeletonBodyText,
  SkeletonDisplayText,
  Text,
  Button,
} from "@shopify/polaris";

import { useI18n } from "../i18n/context";
import type { MessageKey } from "../i18n/catalog";
import { friendlyErrorMessage } from "../lib/admin-api.server";
import { type ImpactMatch, type ImpactResult, effectiveRaw, parseConfig, readConfiguration, simulateImpact } from "../lib/cartguard.server";
import { type RulesState, getAdmin, loadRulesState } from "../lib/dashboard.server";
import { type RuleSection, formatShare, summarizeSections } from "../lib/rule-summary";

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, isDemo } = await getAdmin(request);
  return json<RulesState>(await loadRulesState(admin, isDemo));
}

type CheckResponse = { ok: boolean; impact?: ImpactResult; message?: string; checkedAt?: string };

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await getAdmin(request);
  try {
    const stored = await readConfiguration(admin);
    const impact = await simulateImpact(admin, parseConfig(effectiveRaw(stored)));
    return json<CheckResponse>({ ok: true, impact, checkedAt: new Date().toISOString() });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[CartGuard] Order check failed:", error);
    return json<CheckResponse>({ ok: false, message: friendlyErrorMessage(error) }, { status: 500 });
  }
}

const BLOCKING_SECTIONS: RuleSection[] = ["geo", "address", "quantity"];

type TFn = ReturnType<typeof useI18n>["t"];

const SECTION_TITLE_KEY = {
  geo: "section.geo.title",
  address: "section.address.title",
  quantity: "section.quantity.title",
  vip: "section.vip.title",
} as const satisfies Record<RuleSection, MessageKey>;

function Stat({ label, value, tone }: { label: string; value: string; tone?: "critical" | "success" }) {
  return (
    <BlockStack gap="100">
      <Text as="p" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="p" variant="headingLg" tone={tone}>
        {value}
      </Text>
    </BlockStack>
  );
}

function orderCell(match: ImpactMatch, isDemo: boolean, t: TFn): ReactNode {
  if (isDemo || !match.orderId) {
    return (
      <Text as="span" fontWeight="semibold">
        {match.name}
      </Text>
    );
  }
  // App Bridge opens shopify://admin links in the Shopify admin.
  return (
    <Link url={`shopify://admin/orders/${match.orderId}`} removeUnderline accessibilityLabel={t("orders.openOrder", { name: match.name })}>
      {match.name}
    </Link>
  );
}

function reasonCell(match: ImpactMatch, t: TFn): ReactNode {
  return (
    <BlockStack gap="100">
      <InlineStack gap="100" wrap>
        {match.sections.map((section) => (
          <Badge key={section}>{t(SECTION_TITLE_KEY[section])}</Badge>
        ))}
      </InlineStack>
      {match.reasons.map((reason, index) => (
        <Text as="span" variant="bodySm" key={`${index}-${reason}`}>
          {reason}
        </Text>
      ))}
    </BlockStack>
  );
}

function LoadingState({ t }: { t: TFn }) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="p" visuallyHidden>
          {t("orders.checking")}
        </Text>
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <SkeletonDisplayText size="small" />
          <SkeletonDisplayText size="small" />
          <SkeletonDisplayText size="small" />
        </InlineGrid>
        <SkeletonBodyText lines={6} />
      </BlockStack>
    </Card>
  );
}

function Results({ impact, isDemo, t, number }: { impact: ImpactResult; isDemo: boolean; t: TFn; number: (n: number) => string }) {
  if (impact.scanned === 0) {
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            {t("orders.empty.title")}
          </Text>
          <Text as="p" tone="subdued">
            {t("orders.empty.body")}
          </Text>
        </BlockStack>
      </Card>
    );
  }

  const reasons = BLOCKING_SECTIONS.filter((section) => impact.bySection[section] > 0)
    .map((section) => `${t(SECTION_TITLE_KEY[section])}: ${number(impact.bySection[section])}`)
    .join(" · ");

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="400">
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
            <Stat label={t("orders.checked")} value={number(impact.scanned)} />
            <Stat label={t("orders.wouldStop")} value={number(impact.blocked)} tone={impact.blocked > 0 ? "critical" : "success"} />
            <Stat label={t("orders.share")} value={formatShare(impact.blocked, impact.scanned, t("orders.lessThanOnePercent"))} />
          </InlineGrid>
          {reasons && (
            <Text as="p" variant="bodySm" tone="subdued">
              {t("orders.byRuleType", { reasons })}
            </Text>
          )}
        </BlockStack>
      </Card>

      {impact.matches.length === 0 ? (
        <Banner tone="success" title={t("orders.clean.title")}>
          <Text as="p">{t("orders.clean.body")}</Text>
        </Banner>
      ) : (
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text"]}
            headings={[t("orders.heading.order"), t("orders.heading.shipsTo"), t("orders.heading.reason")]}
            rows={impact.matches.map((match) => [orderCell(match, isDemo, t), match.shipTo, reasonCell(match, t)])}
            verticalAlign="top"
          />
        </Card>
      )}
    </BlockStack>
  );
}

export default function OrderCheckPage() {
  const { t, number, dateTime } = useI18n();
  const { config, isDemo, needsMigration } = useLoaderData<typeof loader>() as unknown as RulesState;
  const fetcher = useFetcher<CheckResponse>();
  const summaries = useMemo(() => summarizeSections(config), [config]);
  const hasRules = BLOCKING_SECTIONS.some((section) => summaries[section].enabled && !summaries[section].empty);
  const busy = fetcher.state !== "idle";
  const data = fetcher.data as CheckResponse | undefined;

  const submit = fetcher.submit;
  const run = useCallback(() => submit({}, { method: "post" }), [submit]);

  // Run once on arrival so the results are one click from the nav.
  const started = useRef(false);
  useEffect(() => {
    if (hasRules && !started.current) {
      started.current = true;
      run();
    }
  }, [hasRules, run]);

  const checkedAt = data?.checkedAt ? dateTime(data.checkedAt) : null;

  let body: ReactNode;
  if (!hasRules) {
    body = (
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            {t("orders.noRules.title")}
          </Text>
          <Text as="p" tone="subdued">
            {t("orders.noRules.body")}
          </Text>
          <InlineStack>
            <Button variant="primary" url="/app/rules">
              {t("orders.noRules.action")}
            </Button>
          </InlineStack>
        </BlockStack>
      </Card>
    );
  } else if (busy || !data) {
    body = <LoadingState t={t} />;
  } else if (!data.ok || !data.impact) {
    body = (
      <Banner tone="critical" title={t("orders.failed")} action={{ content: t("common.tryAgain"), onAction: run }}>
        <Text as="p">{data.message ?? t("orders.failedHint")}</Text>
      </Banner>
    );
  } else {
    body = <Results impact={data.impact} isDemo={isDemo} t={t} number={number} />;
  }

  return (
    <Page
      title={t("orders.title")}
      subtitle={t("orders.subtitle")}
      primaryAction={hasRules ? { content: data ? t("orders.runAgain") : t("orders.run"), onAction: run, loading: busy, disabled: busy } : undefined}
      secondaryActions={hasRules ? [{ content: t("orders.editRules"), url: "/app/rules" }] : []}
    >
      <Layout>
        {needsMigration && (
          <Layout.Section>
            <Banner tone="warning" title={t("hero.migration.title")} action={{ content: t("hero.migration.action"), url: "/app/rules" }}>
              <Text as="p">{t("hero.migration.body")}</Text>
            </Banner>
          </Layout.Section>
        )}
        <Layout.Section>{body}</Layout.Section>
        <Layout.Section>
          <Text as="p" variant="bodySm" tone="subdued">
            {checkedAt ? t("orders.footnoteChecked", { date: checkedAt }) : ""}
            {t("orders.footnote")}
          </Text>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const { t } = useI18n();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  return (
    <Page title={t("orders.title")}>
      <Banner tone="critical" title={t("errors.failedToLoadPage")} action={{ content: t("common.tryAgain"), onAction: () => window.location.reload() }}>
        <Text as="p">{t("common.shopifyUnresponsive")}</Text>
      </Banner>
    </Page>
  );
}
