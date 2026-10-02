/**
 * Persists the merchant's language choice.
 *
 * A resource route with no UI: the language selector posts here and then
 * revalidates, so the whole app re-renders in the new language from the server
 * and there is never a client-side flash of the old language.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { normalizeLanguage } from "../i18n/locales";
import { writeChosenLanguage } from "../i18n/language.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let raw: FormDataEntryValue | null;
  try {
    raw = (await request.formData()).get("language");
  } catch (error) {
    // A body that is not a form at all (a bare POST, or a JSON content type)
    // makes `formData()` reject. That is a malformed request, not a broken
    // app, so it gets a 400 rather than becoming a 500 ErrorBoundary.
    console.error("[CartGuard] Rejected a language request with an unreadable body:", error);
    return json({ ok: false as const, error: "malformed" }, { status: 400 });
  }

  // An empty value clears the choice, which puts the app back on the admin
  // locale rather than pinning it to whatever was last selected.
  const language = raw === null || raw === "" ? null : normalizeLanguage(String(raw));

  if (raw !== null && raw !== "" && !language) {
    return json({ ok: false as const, error: "unsupported" }, { status: 400 });
  }

  try {
    await writeChosenLanguage(shop, language);
  } catch (error) {
    // Returning 200 with `ok: false` rather than letting the rejection escape.
    // A thrown action becomes a 500 ErrorBoundary, which replaces the whole app
    // with an error page; the picker and the Settings selector both surface
    // this response as an inline "could not save" message with the merchant's
    // selection intact, which is recoverable and keeps the app usable.
    console.error("[CartGuard] Could not save the language preference:", error);
    return json({ ok: false as const, error: "save-failed" }, { status: 200 });
  }

  return json({ ok: true as const, language });
};
