/**
 * CartGuard Overview: is checkout protected, which block rules are on, and
 * where to go next.
 */

import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isRouteErrorResponse, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { Fragment, useMemo } from "react";
import { Badge, Banner, BlockStack, Button, Card, Divider, InlineGrid, InlineStack, Layout, Link, Page, Text } from "@shopify/polaris";

import { SectionBadge, sectionStatusText } from "../components/section-status";
import { type RulesState, getAdmin, loadRulesState } from "../lib/dashboard.server";
import { RULE_SECTIONS, SECTION_META, type RuleSection, type SectionSummary, summarizeSections } from "../lib/rule-summary";

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, isDemo } = await getAdmin(request);
  return json<RulesState>(await loadRulesState(admin, isDemo));
}

/** Sections that stop orders. Trusted customers only make exceptions. */
const BLOCKING_SECTIONS: RuleSection[] = ["geo", "address", "quantity"];

const SECTION_PHRASES: Record<RuleSection, string> = {
  geo: "country and region rules",
  address: "address rules",
  quantity: "quantity limits",
  vip: "trusted customers",
};

type Hero = {
  tone: "success" | "warning" | "critical" | "attention";
  background: "bg-surface-success" | "bg-surface-warning" | "bg-surface-critical" | "bg-surface-caution";
  badge: string;
  title: string;
  body: string;
  action?: { content: string; url: string };
};

const listFormat = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

function heroFor(state: RulesState, summaries: Record<RuleSection, SectionSummary>): Hero {
  const { validation, needsMigration } = state;
  if (validation.state === "function_not_deployed") {
    return {
      tone: "critical",
      background: "bg-surface-critical",
      badge: "Not installed",
      title: "Checkout protection isn't installed yet",
      body: "This usually fixes itself within a few minutes of installing CartGuard. If it doesn't, reinstall the app or email support@cartguard.io. Until then, no order is blocked.",
      action: { content: "Open settings", url: "/app/settings" },
    };
  }
  if (validation.state === "unknown") {
    return {
      tone: "warning",
      background: "bg-surface-warning",
      badge: "Status unknown",
      title: "We couldn't check your checkout protection",
      body: validation.message ?? "Shopify didn't respond. Reload the page in a moment.",
      action: { content: "Open settings", url: "/app/settings" },
    };
  }
  if (needsMigration) {
    return {
      tone: "warning",
      background: "bg-surface-warning",
      badge: "Not active",
      title: "Save your rules once to turn protection on",
      body: "Your rules were saved by an older version of CartGuard and aren't applied at checkout yet.",
      action: { content: "Review block rules", url: "/app/rules" },
    };
  }
  if (validation.state !== "active") {
    return {
      tone: "warning",
      background: "bg-surface-warning",
      badge: "Off",
      title: "CartGuard isn't protecting checkout yet",
      body: "Save your block rules to switch protection on. Until then, no order is blocked.",
      action: { content: "Review block rules", url: "/app/rules" },
    };
  }
  const active = BLOCKING_SECTIONS.filter((section) => summaries[section].enabled && !summaries[section].empty);
  if (active.length === 0) {
    return {
      tone: "attention",
      background: "bg-surface-caution",
      badge: "No rules yet",
      title: "Protection is on, but no block rules are set up",
      body: "Add a country, address or quantity rule to start stopping risky orders.",
      action: { content: "Add a block rule", url: "/app/rules" },
    };
  }
  const phrase = listFormat.format(active.map((section) => SECTION_PHRASES[section]));
  return {
    tone: "success",
    background: "bg-surface-success",
    badge: "Protected",
    title: "CartGuard is protecting checkout",
    body: `Your ${phrase} are checked on every checkout.`,
  };
}

function RuleRow({ section, summary }: { section: RuleSection; summary: SectionSummary }) {
  const meta = SECTION_META[section];
  return (
    <InlineGrid columns={{ xs: 1, sm: "1fr auto" }} gap="300" alignItems="center">
      <BlockStack gap="100">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h3" variant="headingSm">
            {meta.title}
          </Text>
          <SectionBadge summary={summary} />
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          {sectionStatusText(summary)}
        </Text>
      </BlockStack>
      <InlineStack>
        <Button url={`/app/rules#${meta.anchor}`} accessibilityLabel={`${summary.enabled ? "Manage" : "Set up"} ${meta.title.toLowerCase()}`}>
          {summary.enabled ? "Manage" : "Set up"}
        </Button>
      </InlineStack>
    </InlineGrid>
  );
}

export default function OverviewPage() {
  const state = useLoaderData<typeof loader>() as unknown as RulesState;
  const summaries = useMemo(() => summarizeSections(state.config), [state.config]);
  const hero = heroFor(state, summaries);

  return (
    <Page
      title="Overview"
      subtitle="CartGuard stops risky and undeliverable orders before checkout completes."
      primaryAction={hero.action ? undefined : { content: "Edit block rules", url: "/app/rules" }}
    >
      <Layout>
        <Layout.Section variant="fullWidth">
          <Card background={hero.background}>
            <InlineGrid columns={{ xs: 1, md: "1fr auto" }} gap="400" alignItems="center">
              <BlockStack gap="200">
                <InlineStack>
                  <Badge tone={hero.tone}>{hero.badge}</Badge>
                </InlineStack>
                <Text as="h2" variant="headingLg">
                  {hero.title}
                </Text>
                <Text as="p">{hero.body}</Text>
              </BlockStack>
              {hero.action && (
                <InlineStack>
                  <Button variant="primary" url={hero.action.url}>
                    {hero.action.content}
                  </Button>
                </InlineStack>
              )}
            </InlineGrid>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Your block rules
                </Text>
                <Button variant="plain" url="/app/rules">
                  Edit all rules
                </Button>
              </InlineStack>
              {RULE_SECTIONS.map((section, index) => (
                <Fragment key={section}>
                  {index > 0 && <Divider />}
                  <RuleRow section={section} summary={summaries[section]} />
                </Fragment>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Order check
                </Text>
                <Text as="p" tone="subdued">
                  See which of your recent orders your rules would stop, and why, before a real customer is affected.
                </Text>
                <InlineStack>
                  <Button url="/app/orders">Check recent orders</Button>
                </InlineStack>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Need help?
                </Text>
                <Text as="p" tone="subdued">
                  Learn <Link url="/app/settings#how-it-works">how CartGuard decides</Link> which orders to stop, or email{" "}
                  <Link url="mailto:support@cartguard.io">support@cartguard.io</Link>.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  return (
    <Page title="Overview">
      <Banner tone="critical" title="CartGuard couldn't load your overview" action={{ content: "Try again", onAction: () => window.location.reload() }}>
        <Text as="p">
          Shopify didn&apos;t respond or returned an error. Your rules haven&apos;t changed and checkout keeps working. Try again in a moment. If this keeps happening, email support@cartguard.io.
        </Text>
      </Banner>
    </Page>
  );
}
