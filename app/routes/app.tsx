import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  let isMock = false;
  try {
    await authenticate.admin(request);
  } catch (error) {
    if (error instanceof Response) {
      const url = new URL(request.url);
      const isEmbedded = url.searchParams.get("embedded") === "1" || Boolean(url.searchParams.get("host"));
      if (!isEmbedded) {
        isMock = true;
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }
  return json({ apiKey: process.env.SHOPIFY_API_KEY ?? "cartguard-dev-api-key", isMock });
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export default function App() {
  const { apiKey, isMock } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp={!isMock} apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">CartGuard</Link>
        <Link to="/app/settings">Checkout rules</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
