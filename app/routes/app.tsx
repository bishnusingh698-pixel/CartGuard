import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const isEmbedded = Boolean(url.searchParams.get("embedded") || url.searchParams.get("host"));
  return json({
    apiKey: process.env.SHOPIFY_API_KEY || "cartguard-preview-key",
    isEmbedded,
  });
};

export const headers: HeadersFunction = () => ({
  "Content-Security-Policy": "frame-ancestors *;",
});

export default function App() {
  const { apiKey, isEmbedded } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp={isEmbedded} apiKey={apiKey}>
      {isEmbedded ? (
        <NavMenu>
          <Link to="/app" rel="home">CartGuard Settings</Link>
        </NavMenu>
      ) : null}
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div className="p-4 bg-red-50 text-red-900">
      <h1 className="text-xl font-bold">App Error</h1>
      <pre>{JSON.stringify(error, null, 2)}</pre>
    </div>
  );
}
