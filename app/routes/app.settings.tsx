/**
 * CartGuard settings: checkout protection status (with a way to switch it
 * back on), how CartGuard decides, and help.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isRouteErrorResponse, useFetcher, useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { useEffect } from "react";
import { Badge, Banner, BlockStack, Button, Card, InlineStack, Layout, Link, List, Page, Text } from "@shopify/polaris";

import { friendlyErrorMessage } from "../lib/admin-api.server";
import { effectiveRaw, parseConfig, readConfiguration, writeFunctionConfiguration } from "../lib/cartguard.server";
import { type RulesState, getAdmin, loadRulesState } from "../lib/dashboard.server";
import { type ValidationStatus, ensureValidationEnabled } from "../lib/validation.server";
import { useI18n } from "../i18n/context";
import { readSavedLanguage } from "../i18n/language.server";
import type { Language } from "../i18n/locales";
import type { MessageKey } from "../i18n/catalog";
import { LanguageSetting } from "../components/language-picker";

/** Shown as a mailto link, so it is a constant rather than a catalog string. */
const SUPPORT_EMAIL = "support@cartguard.io";

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, isDemo, shop } = await getAdmin(request);
  const [state, saved] = await Promise.all([loadRulesState(admin, isDemo), readSavedLanguage(shop)]);
  return json({
    ...state,
    /** The saved choice, so the select shows what is actually stored. */
    savedLanguage: saved.language,
    languageAsked: saved.asked,
  });
}

type ActivateResponse = { ok: boolean; message?: string };

/** Turns CartGuard's checkout rule on with the rules that are already saved. */
export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await getAdmin(request);
  try {
    const stored = await readConfiguration(admin);
    const validationId = await ensureValidationEnabled(admin);
    await writeFunctionConfiguration(admin, validationId, parseConfig(effectiveRaw(stored)));
    return json<ActivateResponse>({ ok: true });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[CartGuard] Turning on checkout protection failed:", error);
    return json<ActivateResponse>({ ok: false, message: friendlyErrorMessage(error) }, { status: 500 });
  }
}

/**
 * Status copy is looked up by catalog key rather than stored as a string, so
 * every state stays translatable. The keys are typed as `MessageKey`, so a
 * renamed or deleted key is a compile error here rather than a raw key
 * rendered in the badge.
 */
const STATUS: Record<
  ValidationStatus["state"],
  { tone: "success" | "warning" | "critical"; badge: MessageKey; text: MessageKey }
> = {
  active: { tone: "success", badge: "common.on", text: "settings.protection.active.text" },
  inactive: { tone: "warning", badge: "common.off", text: "settings.protection.inactive.text" },
  missing: { tone: "warning", badge: "common.off", text: "settings.protection.missing.text" },
  function_not_deployed: {
    tone: "critical",
    badge: "common.notInstalled",
    text: "settings.protection.notInstalled.text",
  },
  unknown: { tone: "warning", badge: "common.unknown", text: "settings.protection.unknown.text" },
};

const DECISION_STEPS = [
  "settings.how.step1",
  "settings.how.step2",
  "settings.how.step3",
  "settings.how.step4",
  "settings.how.step5",
] as const;

export default function SettingsPage() {
  const { validation, needsMigration, savedLanguage, languageAsked } = useLoaderData<typeof loader>() as unknown as RulesState & {
    savedLanguage: Language | null;
    languageAsked: boolean;
  };
  const { t, language } = useI18n();
  const fetcher = useFetcher<ActivateResponse>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const status = STATUS[validation.state];
  const canActivate = validation.state === "inactive" || validation.state === "missing";
  const activating = fetcher.state !== "idle";
  const failed = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.message : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) shopify?.toast?.show(t("settings.protection.activate"));
  }, [fetcher.state, fetcher.data, shopify, t]);

  return (
    <Page title={t("settings.title")}>
      <Layout>
        {needsMigration && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={t("settings.migration.title")}
              action={{ content: t("settings.migration.action"), url: "/app/rules" }}
            >
              <Text as="p">{t("settings.migration.body")}</Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.AnnotatedSection
          id="language"
          title={t("language.title")}
          description={t("language.description")}
        >
          <Card>
            <LanguageSetting value={savedLanguage ?? language} chosen={languageAsked} detected={!languageAsked} />
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          id="checkout-protection"
          title={t("settings.protection.title")}
          description={t("settings.protection.description")}
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  {t("settings.protection.statusLabel")}
                </Text>
                <Badge tone={status.tone}>{t(status.badge as MessageKey)}</Badge>
              </InlineStack>
              <Text as="p">
                {validation.state === "unknown" && validation.message
                  ? validation.message
                  : t(status.text as MessageKey)}
              </Text>
              {failed && (
                <Banner tone="critical" title={t("settings.protection.failed")}>
                  <Text as="p">{failed}</Text>
                </Banner>
              )}
              <InlineStack gap="200">
                {canActivate && (
                  <Button variant="primary" loading={activating} onClick={() => fetcher.submit({}, { method: "post" })}>
                    {t("settings.protection.activate")}
                  </Button>
                )}
                <Button loading={revalidator.state === "loading"} disabled={activating} onClick={() => revalidator.revalidate()}>
                  {t("settings.protection.checkAgain")}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection id="how-it-works" title={t("settings.how.title")} description={t("settings.how.description")}>
          <Card>
            <BlockStack gap="300">
              <List type="number">
                {DECISION_STEPS.map((step) => (
                  <List.Item key={step}>{t(step)}</List.Item>
                ))}
              </List>
              <Text as="p" variant="bodySm" tone="subdued">
                {t("settings.how.failOpen")}
              </Text>
              <InlineStack>
                <Button url="/app/rules">{t("settings.how.editRules")}</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection id="help" title={t("settings.help.title")} description={t("settings.help.description")}>
          <Card>
            <BlockStack gap="200">
              <Text as="p">
                {t("settings.help.email", { email: SUPPORT_EMAIL })}
              </Text>
              <Text as="p">
                {t("settings.help.privacyPrefix")}{" "}
                <Link url="/privacy" target="_blank">
                  {t("settings.help.privacyLink")}
                </Link>{" "}
                {t("settings.help.privacySuffix")}
              </Text>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  const { t } = useI18n();
  const error = useRouteError();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  return (
    <Page title={t("settings.title")}>
      <Banner
        tone="critical"
        title={t("errors.failedToLoadSettings")}
        action={{ content: t("common.tryAgain"), onAction: () => window.location.reload() }}
      >
        <Text as="p">{t("common.shopifyUnresponsive")}</Text>
      </Banner>
    </Page>
  );
}
