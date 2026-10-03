/**
 * CartGuard Overview: is checkout protected, which block rules are on, and
 * where to go next.
 */

import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isRouteErrorResponse, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { Fragment, type ReactNode, useMemo } from "react";
import { Badge, Banner, BlockStack, Button, Card, Divider, InlineGrid, InlineStack, Layout, Link, Page, Text } from "@shopify/polaris";

import { useI18n } from "../i18n/context";
import type { MessageKey } from "../i18n/catalog";
import { SectionBadge, useSectionStatusText } from "../components/section-status";
import { type RulesState, getAdmin, loadRulesState } from "../lib/dashboard.server";
import { RULE_SECTIONS, SECTION_META, SECTION_TITLE_KEY, type RuleSection, type SectionSummary, summarizeSections } from "../lib/rule-summary";

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, isDemo } = await getAdmin(request);
  return json<RulesState>(await loadRulesState(admin, isDemo));
}

/** Sections that stop orders. Trusted customers only make exceptions. */
const BLOCKING_SECTIONS: RuleSection[] = ["geo", "address", "quantity"];

const SUPPORT_EMAIL = "support@cartguard.io";

const SECTION_PHRASE_KEY: Record<RuleSection, MessageKey> = {
  geo: "overview.phrase.geo",
  address: "overview.phrase.address",
  quantity: "overview.phrase.quantity",
  vip: "overview.phrase.vip",
};

type TFn = ReturnType<typeof useI18n>["t"];
type ListFn = ReturnType<typeof useI18n>["list"];

type Hero = {
  tone: "success" | "warning" | "critical" | "attention";
  background: "bg-surface-success" | "bg-surface-warning" | "bg-surface-critical" | "bg-surface-caution";
  badge: string;
  title: string;
  body: string;
  action?: { content: string; url: string };
};

function heroFor(state: RulesState, summaries: Record<RuleSection, SectionSummary>, t: TFn, list: ListFn): Hero {
  const { validation, needsMigration } = state;
  if (validation.state === "function_not_deployed") {
    return {
      tone: "critical",
      background: "bg-surface-critical",
      badge: t("common.notInstalled"),
      title: t("hero.notInstalled.title"),
      body: t("hero.notInstalled.body"),
      action: { content: t("hero.notInstalled.action"), url: "/app/settings" },
    };
  }
  if (validation.state === "unknown") {
    return {
      tone: "warning",
      background: "bg-surface-warning",
      badge: t("hero.unknown.badge"),
      title: t("hero.unknown.title"),
      body: validation.message ?? t("hero.unknown.body"),
      action: { content: t("common.manage"), url: "/app/settings" },
    };
  }
  if (needsMigration) {
    return {
      tone: "warning",
      background: "bg-surface-warning",
      badge: t("hero.migration.badge"),
      title: t("hero.migration.title"),
      body: t("hero.migration.body"),
      action: { content: t("hero.migration.action"), url: "/app/rules" },
    };
  }
  if (validation.state !== "active") {
    return {
      tone: "warning",
      background: "bg-surface-warning",
      badge: t("hero.off.badge"),
      title: t("hero.off.title"),
      body: t("hero.off.body"),
      action: { content: t("hero.migration.action"), url: "/app/rules" },
    };
  }
  const active = BLOCKING_SECTIONS.filter((section) => summaries[section].enabled && !summaries[section].empty);
  if (active.length === 0) {
    return {
      tone: "attention",
      background: "bg-surface-caution",
      badge: t("hero.noRules.badge"),
      title: t("hero.noRules.title"),
      body: t("hero.noRules.body"),
      action: { content: t("hero.noRules.action"), url: "/app/rules" },
    };
  }
  return {
    tone: "success",
    background: "bg-surface-success",
    badge: t("hero.protected.badge"),
    title: t("hero.protected.title"),
    body: t("hero.protected.body", { rules: list(active.map((section) => t(SECTION_PHRASE_KEY[section]))) }),
  };
}

function RuleRow({ section, summary }: { section: RuleSection; summary: SectionSummary }) {
  const { t } = useI18n();
  const statusText = useSectionStatusText(summary);
  const action = summary.enabled ? t("common.manage") : t("common.setUp");
  return (
    <InlineGrid columns={{ xs: 1, sm: "1fr auto" }} gap="300" alignItems="center">
      <BlockStack gap="100">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h3" variant="headingSm">
            {t(SECTION_TITLE_KEY[section])}
          </Text>
          <SectionBadge summary={summary} />
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          {statusText}
        </Text>
      </BlockStack>
      <InlineStack>
        <Button url={`/app/rules#${SECTION_META[section].anchor}`} accessibilityLabel={`${action}: ${t(SECTION_TITLE_KEY[section])}`}>
          {action}
        </Button>
      </InlineStack>
    </InlineGrid>
  );
}

/**
 * `overview.help.body` carries `{link}` and `{email}` placeholders, and each
 * language orders them differently. Splitting on the placeholders keeps the
 * translator in charge of word order while still yielding real anchors, which a
 * plain string interpolation could not do.
 */
function renderLinkedHelp(body: string, t: TFn): ReactNode[] {
  const parts = body.split(/(\{link\}|\{email\})/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part === "{link}") return <Link key={index} url="/app/settings#how-it-works">{t("overview.help.link")}</Link>;
    if (part === "{email}") return <Link key={index} url="mailto:support@cartguard.io">{SUPPORT_EMAIL}</Link>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export default function OverviewPage() {
  const { t, list } = useI18n();
  const state = useLoaderData<typeof loader>() as unknown as RulesState;
  const summaries = useMemo(() => summarizeSections(state.config), [state.config]);
  const hero = heroFor(state, summaries, t, list);

  return (
    <Page
      title={t("overview.title")}
      subtitle={t("overview.subtitle")}
      primaryAction={hero.action ? undefined : { content: t("overview.editRules"), url: "/app/rules" }}
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
                  {t("overview.yourRules")}
                </Text>
                <Button variant="plain" url="/app/rules">
                  {t("overview.editAllRules")}
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
                  {t("overview.orderCheck.title")}
                </Text>
                <Text as="p" tone="subdued">
                  {t("overview.orderCheck.body")}
                </Text>
                <InlineStack>
                  <Button url="/app/orders">{t("overview.orderCheck.action")}</Button>
                </InlineStack>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  {t("overview.help.title")}
                </Text>
                <Text as="p" tone="subdued">
                  {renderLinkedHelp(t("overview.help.body"), t)}
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
  const { t } = useI18n();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  return (
    <Page title={t("overview.title")}>
      <Banner tone="critical" title={t("errors.failedToLoadOverview")} action={{ content: t("common.tryAgain"), onAction: () => window.location.reload() }}>
        <Text as="p">
          {t("common.shopifyUnresponsive")} {t("errors.withSupport")}
        </Text>
      </Banner>
    </Page>
  );
}
