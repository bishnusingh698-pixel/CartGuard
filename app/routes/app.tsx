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
  { url: "/app", label: "Overview" },
  { url: "/app/rules", label: "Block rules" },
  { url: "/app/orders", label: "Order check" },
  { url: "/app/settings", label: "Settings" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  let isMock = false;
  try {
    await authenticate.admin(request);
  } catch (error) {
    // Auth redirects / bounces must reach the browser. Only a local,
    // non-embedded preview may fall back to demo data.
    if (error instanceof Response && canUseMockAdmin(request)) {
      isMock = true;
    } else {
      throw error;
    }
  }
  return json({ apiKey: process.env.SHOPIFY_API_KEY ?? "", isMock });
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
  return (
    <nav aria-label="CartGuard pages">
      <InlineStack gap="200" wrap>
        {NAV_ITEMS.map((item) => (
          <Button key={item.url} pressed={isActive(pathname, item.url)} onClick={() => navigate(item.url)}>
            {item.label}
          </Button>
        ))}
      </InlineStack>
    </nav>
  );
}

export default function App() {
  const { apiKey, isMock } = useLoaderData<typeof loader>();

  return (
    <>
      {isMock && <script dangerouslySetInnerHTML={{ __html: DEMO_APP_BRIDGE_STUB }} />}
      <AppProvider isEmbeddedApp={!isMock} apiKey={apiKey}>
        <NavMenu>
          <Link to="/app" rel="home">
            Overview
          </Link>
          {NAV_ITEMS.slice(1).map((item) => (
            <Link key={item.url} to={item.url}>
              {item.label}
            </Link>
          ))}
        </NavMenu>
        <NavigationProgress />
        {isMock && (
          <Box padding="400">
            <BlockStack gap="300">
              <Banner tone="info" title="Demo mode">
                <Text as="p">You&apos;re viewing sample data outside the Shopify admin. Nothing here is saved to a real store.</Text>
              </Banner>
              <DemoNav />
            </BlockStack>
          </Box>
        )}
        <Outlet />
      </AppProvider>
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
