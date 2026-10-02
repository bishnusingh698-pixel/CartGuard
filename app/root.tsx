import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useRouteError,
  useRouteLoaderData,
} from "@remix-run/react";
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import type { ReactNode } from "react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import tailwindCss from "./tailwind.css?url";

import { I18nProvider, useI18n } from "./i18n/context";
import { resolveRequestLanguage } from "./i18n/language.server";
import { readRequestShop } from "./lib/request-shop.server";
import { DEFAULT_LANGUAGE, type Language } from "./i18n/locales";

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

/**
 * Resolves the language for the document itself.
 *
 * Root's loader runs before any nested loader, so the very first byte of HTML
 * already carries the right `lang` and the right translated copy. A language
 * the merchant saved wins over the admin locale.
 *
 * The shop comes from `readRequestShop`, which reads the authenticated session
 * and falls back to the `shop` parameter. It must not be the parameter alone:
 * a merchant who installed the app as a non-embedded app reaches `/app`
 * without one, and root would then ignore their saved preference and emit
 * `lang="en"` while `app.tsx` rendered Japanese — two different languages in
 * one document.
 *
 * It never throws: a database problem must degrade to English rather than break
 * the page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = await readRequestShop(request);
  const { language } = await resolveRequestLanguage(request, { shop }).catch(() => ({
    language: DEFAULT_LANGUAGE,
    chosen: false,
    detected: false,
  }));
  return json({ language });
};

// App Bridge must be the first script the embedded app loads (AppProvider in
// app/routes/app.tsx injects it). Nothing here may pre-define window.shopify or
// the ui-* custom elements, or App Bridge fails to register them in the admin.
function Document({ children, language }: { children: ReactNode; language: Language }) {
  return (
    <html lang={language}>
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
  const { language } = useLoaderData<typeof loader>();
  return (
    <I18nProvider language={language}>
      <DocumentShell>
        <Outlet />
      </DocumentShell>
    </I18nProvider>
  );
}

/** Reads the active language so `<html lang>` always matches the rendered copy. */
function DocumentShell({ children }: { children: ReactNode }) {
  const { language } = useI18n();
  return <Document language={language}>{children}</Document>;
}

/** Last-resort error page: never a white screen or a stack trace. */
export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <BoundaryDocument>
      <ErrorPage notFound={notFound} />
    </BoundaryDocument>
  );
}

/**
 * The error boundary can run when the root loader never completed, so there may
 * be no language to read. It returns undefined rather than throwing in that
 * case, and we fall back to English, because a readable page beats a
 * correctly-localised broken one.
 */
function BoundaryDocument({ children }: { children: ReactNode }) {
  // `useRouteLoaderData` rather than `useLoaderData`, so the read is tied to
  // this route's data and never throws when the data is absent.
  const language = useRouteLoaderData<typeof loader>("root")?.language ?? DEFAULT_LANGUAGE;
  return (
    <I18nProvider language={language}>
      <Document language={language}>{children}</Document>
    </I18nProvider>
  );
}

function ErrorPage({ notFound }: { notFound: boolean }) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-800">
      <div role="alert" className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold text-slate-900">
          {notFound ? t("errors.notFound.title") : t("errors.generic.title")}
        </h1>
        <p className="mb-6 text-sm leading-6">{notFound ? t("errors.notFound.body") : t("errors.generic.body")}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
        >
          {t("common.reloadPage")}
        </button>
      </div>
    </main>
  );
}
