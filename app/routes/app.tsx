import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useLocation, useNavigate, useNavigation, useRouteError } from "@remix-run/react";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { NavMenu, useAppBridge } from "@shopify/app-bridge-react";
import { Banner, BlockStack, Box, Button, InlineStack, Text } from "@shopify/polaris";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { canUseMockAdmin } from "../lib/admin-mock.server";
import { I18nProvider, useI18n } from "../i18n/context";
import { resolveRequestLanguage } from "../i18n/language.server";
import { LanguageOnboarding } from "../components/language-picker";
import type { Language } from "../i18n/locales";

// Minimal stand-in for window.shopify, rendered only in local demo mode
// (outside the Shopify admin, never in production). In the real admin App
// Bridge provides it, and pre-defining it there would break App Bridge.
const DEMO_APP_BRIDGE_STUB = `
if (!window.shopify) {
  window.shopify = {
    toast: { show: function (msg) { console.log("[CartGuard demo toast]", msg); } },
    environment: { embedded: false },
    config: { apiKey: "" }
  };
}
`;

/** Every page in the app. The first one is the home page. */
const NAV_ITEMS = [
  { url: "/app", label: "nav.overview" },
  { url: "/app/rules", label: "nav.rules" },
  { url: "/app/orders", label: "nav.orders" },
  { url: "/app/settings", label: "nav.settings" },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  let isMock = false;
  let shop: string | undefined;
  try {
    const context = await authenticate.admin(request);
    shop = context.session.shop;
  } catch (error) {
    // Auth redirects / bounces must reach the browser. Only a local,
    // non-embedded preview may fall back to demo data.
    if (error instanceof Response && canUseMockAdmin(request)) {
      isMock = true;
    } else {
      throw error;
    }
  }
  // Resolved here rather than read from the root loader because only this
  // loader knows the authenticated shop. Both calls agree, so `<html lang>`
  // and the app can never disagree about the language.
  const { language, chosen } = await resolveRequestLanguage(request, { shop });
  return json({
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    isMock,
    language,
    // Drives the one-time language picker and the Settings notice.
    languageChosen: chosen,
  });
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function isActive(pathname: string, url: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return url === "/app" ? path === "/app" : path === url || path.startsWith(`${url}/`);
}

/** Shows App Bridge's loading bar while moving between pages. */
function NavigationProgress() {
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const loading = navigation.state !== "idle";
  useEffect(() => {
    try {
      shopify?.loading?.(loading);
    } catch {
      // Not available outside the Shopify admin (demo mode).
    }
  }, [shopify, loading]);
  return null;
}

/** The admin sidebar isn't there in demo mode, so show the same pages here. */
function DemoNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <nav aria-label={t("nav.label")}>
      <InlineStack gap="200" wrap>
        {NAV_ITEMS.map((item) => (
          <Button key={item.url} pressed={isActive(pathname, item.url)} onClick={() => navigate(item.url)}>
            {t(item.label)}
          </Button>
        ))}
      </InlineStack>
    </nav>
  );
}

export default function App() {
  const { apiKey, isMock, language, languageChosen } = useLoaderData<typeof loader>();

  return (
    <>
      {isMock && <script dangerouslySetInnerHTML={{ __html: DEMO_APP_BRIDGE_STUB }} />}
      <I18nProvider language={language}>
        <AdminShell apiKey={apiKey} isMock={isMock} language={language} languageChosen={languageChosen} />
      </I18nProvider>
    </>
  );
}

/**
 * Inside the provider so the nav and demo banner can translate. Split out only
 * because `useI18n` needs the provider to already be above it in the tree.
 *
 * Polaris gets its catalog from the context, which resolves it from the same
 * language, so a Polaris button's own "Cancel" is translated too.
 */
function AdminShell({
  apiKey,
  isMock,
  language,
  languageChosen,
}: {
  apiKey: string;
  isMock: boolean;
  language: Language;
  languageChosen: boolean;
}) {
  const { t, polarisI18n } = useI18n();
  return (
    <AppProvider isEmbeddedApp={!isMock} apiKey={apiKey} i18n={polarisI18n}>
      {/* Only inside the admin. `NavMenu` is an App Bridge component: it
          registers links with the Shopify admin's sidebar, and with no App
          Bridge running (the demo preview) it renders its children as plain
          unstyled anchors, dumping a second copy of the navigation above the
          demo one. DemoNav below is the standalone replacement. */}
      {!isMock && (
        <NavMenu>
          <Link to="/app" rel="home">
            {t("nav.overview")}
          </Link>
          {NAV_ITEMS.slice(1).map((item) => (
            <Link key={item.url} to={item.url}>
              {t(item.label)}
            </Link>
          ))}
        </NavMenu>
      )}
      <NavigationProgress />
      {isMock && (
        <Box padding="400">
          <BlockStack gap="300">
            <Banner tone="info" title={t("demo.title")}>
              <Text as="p">{t("demo.body")}</Text>
            </Banner>
            <DemoNav />
          </BlockStack>
        </Box>
      )}
      <Outlet />
      {/* Shown once. Answering it, including skipping, stamps the shop's
          preference so it does not reappear on the next page load. Not
          offered in the demo preview, where there is no shop to save against
          and posting would redirect to OAuth. */}
      {!languageChosen && <LanguageOnboarding detectedLanguage={language} savable={!isMock} />}
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
