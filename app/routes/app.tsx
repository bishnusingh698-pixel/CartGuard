import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { NavMenu } from "@shopify/app-bridge-react";
import { Banner, Box, Text } from "@shopify/polaris";
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

export default function App() {
  const { apiKey, isMock } = useLoaderData<typeof loader>();

  return (
    <>
      {isMock && <script dangerouslySetInnerHTML={{ __html: DEMO_APP_BRIDGE_STUB }} />}
      <AppProvider isEmbeddedApp={!isMock} apiKey={apiKey}>
        <NavMenu>
          <Link to="/app" rel="home">CartGuard</Link>
          <Link to="/app/settings">Checkout rules</Link>
        </NavMenu>
        {isMock && (
          <Box padding="400">
            <Banner tone="info" title="Demo mode">
              <Text as="p">You're viewing sample data outside the Shopify admin. Nothing here is saved to a real store.</Text>
            </Banner>
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
