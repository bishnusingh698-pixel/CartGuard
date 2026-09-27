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

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, isDemo } = await getAdmin(request);
  return json<RulesState>(await loadRulesState(admin, isDemo));
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

const STATUS: Record<ValidationStatus["state"], { tone: "success" | "warning" | "critical"; label: string; text: string }> = {
  active: { tone: "success", label: "On", text: "CartGuard checks every checkout against your block rules." },
  inactive: { tone: "warning", label: "Off", text: "CartGuard's checkout check is switched off, so no order is blocked." },
  missing: { tone: "warning", label: "Off", text: "CartGuard's checkout check hasn't been set up yet, so no order is blocked." },
  function_not_deployed: {
    tone: "critical",
    label: "Not installed",
    text: "CartGuard's checkout check isn't installed on your store yet. This usually fixes itself within a few minutes of installing. If it doesn't, reinstall CartGuard or email support@cartguard.io.",
  },
  unknown: { tone: "warning", label: "Unknown", text: "We couldn't reach Shopify to check. Try again in a moment." },
};

export default function SettingsPage() {
  const { validation, needsMigration } = useLoaderData<typeof loader>() as unknown as RulesState;
  const fetcher = useFetcher<ActivateResponse>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const status = STATUS[validation.state];
  const canActivate = validation.state === "inactive" || validation.state === "missing";
  const activating = fetcher.state !== "idle";
  const failed = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.message : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) shopify?.toast?.show("Checkout protection is on.");
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <Page title="Settings">
      <Layout>
        {needsMigration && (
          <Layout.Section>
            <Banner tone="warning" title="Your rules aren't applied at checkout yet" action={{ content: "Review block rules", url: "/app/rules" }}>
              <Text as="p">They were saved by an older version of CartGuard. Save them once on the Block rules page to apply them.</Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.AnnotatedSection
          id="checkout-protection"
          title="Checkout protection"
          description="CartGuard runs inside Shopify checkout. If it was switched off, you can turn it back on here."
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Status
                </Text>
                <Badge tone={status.tone}>{status.label}</Badge>
              </InlineStack>
              <Text as="p">{validation.state === "unknown" && validation.message ? validation.message : status.text}</Text>
              {failed && (
                <Banner tone="critical" title="Checkout protection couldn't be turned on">
                  <Text as="p">{failed}</Text>
                </Banner>
              )}
              <InlineStack gap="200">
                {canActivate && (
                  <Button variant="primary" loading={activating} onClick={() => fetcher.submit({}, { method: "post" })}>
                    Turn on checkout protection
                  </Button>
                )}
                <Button loading={revalidator.state === "loading"} disabled={activating} onClick={() => revalidator.revalidate()}>
                  Check again
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          id="how-it-works"
          title="How CartGuard decides"
          description="Every checkout goes through these steps in order. The first rule an order breaks stops it."
        >
          <Card>
            <BlockStack gap="300">
              <List type="number">
                <List.Item>Blocked countries are always stopped, even for trusted customers.</List.Item>
                <List.Item>Trusted customers who are signed in skip every other rule.</List.Item>
                <List.Item>Order quantities are checked against your limits.</List.Item>
                <List.Item>Delivery addresses are checked for PO Boxes, reshippers, blocked words and specific addresses.</List.Item>
                <List.Item>Blocked states, cities and postal codes are checked.</List.Item>
              </List>
              <Text as="p" variant="bodySm" tone="subdued">
                If CartGuard ever runs into a problem, checkout stays open instead of blocking customers.
              </Text>
              <InlineStack>
                <Button url="/app/rules">Edit block rules</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection id="help" title="Help and privacy" description="Questions, problems or data requests.">
          <Card>
            <BlockStack gap="200">
              <Text as="p">
                Email <Link url="mailto:support@cartguard.io">support@cartguard.io</Link> for help with CartGuard.
              </Text>
              <Text as="p">
                Read how CartGuard handles your data in the{" "}
                <Link url="/privacy" target="_blank">
                  privacy policy
                </Link>
                .
              </Text>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  return (
    <Page title="Settings">
      <Banner tone="critical" title="CartGuard couldn't load settings" action={{ content: "Try again", onAction: () => window.location.reload() }}>
        <Text as="p">
          Shopify didn&apos;t respond or returned an error. Your rules haven&apos;t changed and checkout keeps working. Try again in a moment.
        </Text>
      </Banner>
    </Page>
  );
}
