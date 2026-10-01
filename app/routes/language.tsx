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
  const form = await request.formData();
  const raw = form.get("language");
  // An empty value clears the choice, which puts the app back on the admin
  // locale rather than pinning it to whatever was last selected.
  const language = raw === null || raw === "" ? null : normalizeLanguage(String(raw));

  if (raw !== null && raw !== "" && !language) {
    return json({ ok: false as const, error: "unsupported" }, { status: 400 });
  }

  await writeChosenLanguage(shop, language);
  return json({ ok: true as const, language });
};
