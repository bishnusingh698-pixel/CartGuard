import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "@remix-run/react";
import type { LinksFunction, MetaFunction } from "@remix-run/node";
import type { ReactNode } from "react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import tailwindCss from "./tailwind.css?url";

export const meta: MetaFunction = () => [
  { title: "CartGuard" },
  { property: "og:title", content: "CartGuard" },
  { name: "description", content: "Fraud prevention and cart validation rules enforced at checkout." },
  { property: "og:description", content: "Fraud prevention and cart validation rules enforced at checkout." },
];

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: tailwindCss },
];

// App Bridge must be the first script the embedded app loads (AppProvider in
// app/routes/app.tsx injects it). Nothing here may pre-define window.shopify or
// the ui-* custom elements, or App Bridge fails to register them in the admin.
function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <Document>
      <Outlet />
    </Document>
  );
}

/** Last-resort error page: never a white screen or a stack trace. */
export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <Document>
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-800">
        <div role="alert" className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="mb-2 text-xl font-semibold text-slate-900">{notFound ? "Page not found" : "Something went wrong"}</h1>
          <p className="mb-6 text-sm leading-6">
            {notFound
              ? "This page doesn't exist. Open CartGuard from your Shopify admin to get back to your checkout rules."
              : "CartGuard couldn't load this page. Your checkout rules haven't changed and checkout keeps working. Reload the page, or open CartGuard again from your Shopify admin."}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
          >
            Reload page
          </button>
        </div>
      </main>
    </Document>
  );
}
