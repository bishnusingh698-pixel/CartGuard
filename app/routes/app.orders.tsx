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

import { friendlyErrorMessage } from "../lib/admin-api.server";
import { type ImpactMatch, type ImpactResult, effectiveRaw, parseConfig, readConfiguration, simulateImpact } from "../lib/cartguard.server";
import { type RulesState, getAdmin, loadRulesState } from "../lib/dashboard.server";
import { SECTION_META, type RuleSection, formatNumber, formatShare, summarizeSections } from "../lib/rule-summary";

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

function orderCell(match: ImpactMatch, isDemo: boolean): ReactNode {
  if (isDemo || !match.orderId) {
    return (
      <Text as="span" fontWeight="semibold">
        {match.name}
      </Text>
    );
  }
  // App Bridge opens shopify://admin links in the Shopify admin.
  return (
    <Link url={`shopify://admin/orders/${match.orderId}`} removeUnderline accessibilityLabel={`Open order ${match.name} in Shopify`}>
      {match.name}
    </Link>
  );
}

function reasonCell(match: ImpactMatch): ReactNode {
  return (
    <BlockStack gap="100">
      <InlineStack gap="100" wrap>
        {match.sections.map((section) => (
          <Badge key={section}>{SECTION_META[section].title}</Badge>
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

function LoadingState() {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="p" visuallyHidden>
          Checking your recent orders…
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

function Results({ impact, isDemo }: { impact: ImpactResult; isDemo: boolean }) {
  if (impact.scanned === 0) {
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            No orders to check yet
          </Text>
          <Text as="p" tone="subdued">
            Once customers start ordering, come back here to see how your rules would treat them. Your rules already apply to new checkouts.
          </Text>
        </BlockStack>
      </Card>
    );
  }

  const reasons = BLOCKING_SECTIONS.filter((section) => impact.bySection[section] > 0)
    .map((section) => `${SECTION_META[section].title}: ${formatNumber(impact.bySection[section])}`)
    .join(" · ");

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="400">
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
            <Stat label="Orders checked" value={formatNumber(impact.scanned)} />
            <Stat label="Would be stopped" value={formatNumber(impact.blocked)} tone={impact.blocked > 0 ? "critical" : "success"} />
            <Stat label="Share of orders" value={formatShare(impact.blocked, impact.scanned)} />
          </InlineGrid>
          {reasons && (
            <Text as="p" variant="bodySm" tone="subdued">
              By rule type: {reasons}
            </Text>
          )}
        </BlockStack>
      </Card>

      {impact.matches.length === 0 ? (
        <Banner tone="success" title="None of these orders would have been stopped">
          <Text as="p">Your rules let all of your recent orders through.</Text>
        </Banner>
      ) : (
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text"]}
            headings={["Order", "Ships to", "Why it would be stopped"]}
            rows={impact.matches.map((match) => [orderCell(match, isDemo), match.shipTo, reasonCell(match)])}
            verticalAlign="top"
          />
        </Card>
      )}
    </BlockStack>
  );
}

export default function OrderCheckPage() {
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

  const checkedAt = data?.checkedAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.checkedAt))
    : null;

  let body: ReactNode;
  if (!hasRules) {
    body = (
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            No block rules to test yet
          </Text>
          <Text as="p" tone="subdued">
            Turn on a country, address or quantity rule, then come back to see which recent orders it would stop.
          </Text>
          <InlineStack>
            <Button variant="primary" url="/app/rules">
              Add a block rule
            </Button>
          </InlineStack>
        </BlockStack>
      </Card>
    );
  } else if (busy || !data) {
    body = <LoadingState />;
  } else if (!data.ok || !data.impact) {
    body = (
      <Banner tone="critical" title="The order check didn't finish" action={{ content: "Try again", onAction: run }}>
        <Text as="p">{data.message ?? "Shopify didn't respond. Try again in a moment."}</Text>
      </Banner>
    );
  } else {
    body = <Results impact={data.impact} isDemo={isDemo} />;
  }

  return (
    <Page
      title="Order check"
      subtitle="See which of your recent orders your saved block rules would stop, and why."
      primaryAction={hasRules ? { content: data ? "Run again" : "Run check", onAction: run, loading: busy, disabled: busy } : undefined}
      secondaryActions={hasRules ? [{ content: "Edit block rules", url: "/app/rules" }] : []}
    >
      <Layout>
        {needsMigration && (
          <Layout.Section>
            <Banner tone="warning" title="These rules aren't applied at checkout yet" action={{ content: "Review block rules", url: "/app/rules" }}>
              <Text as="p">They were saved by an older version of CartGuard. Save them once on the Block rules page to apply them.</Text>
            </Banner>
          </Layout.Section>
        )}
        <Layout.Section>{body}</Layout.Section>
        <Layout.Section>
          <Text as="p" variant="bodySm" tone="subdued">
            {checkedAt ? `Checked ${checkedAt}. ` : ""}
            Shopify doesn&apos;t tell apps when a checkout is blocked, so this page tests your saved rules on up to your last 100 real orders
            (40 products each). Trusted customers are recognised by the order email.
          </Text>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  return (
    <Page title="Order check">
      <Banner tone="critical" title="CartGuard couldn't load this page" action={{ content: "Try again", onAction: () => window.location.reload() }}>
        <Text as="p">
          Shopify didn&apos;t respond or returned an error. Your rules haven&apos;t changed and checkout keeps working. Try again in a moment.
        </Text>
      </Banner>
    </Page>
  );
}
