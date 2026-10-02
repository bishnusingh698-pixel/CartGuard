/**
 * Which shop does this request belong to, for loaders that must never redirect.
 *
 * Root needs this so `<html lang>` can honour a saved language preference, but
 * root also renders the privacy policy and the login pages, which exist
 * precisely because there is no session. So this cannot authenticate naively:
 * the redirect `authenticate.admin` throws for a signed-out request would
 * replace those pages with an OAuth bounce.
 *
 * It lives apart from the language resolver because it pulls in the whole
 * Shopify app bootstrap. Language resolution is pure precedence logic that
 * should stay testable without a Prisma session table behind it.
 */

import { authenticate } from "../shopify.server";

/**
 * One authentication per request, shared by root and `app.tsx`.
 *
 * Keyed on the `Request` object, so nothing leaks between requests and the
 * entry is collected once the request is done.
 */
const shopByRequest = new WeakMap<Request, Promise<string | undefined>>();

export function readRequestShop(request: Request): Promise<string | undefined> {
  const cached = shopByRequest.get(request);
  if (cached) return cached;

  const pending = (async () => {
    try {
      const { session } = await authenticate.admin(request);
      return session.shop;
    } catch {
      // Unauthenticated, a bot, or a page that exists to work signed out. The
      // `shop` parameter is the only unauthenticated fallback; callers must
      // treat it as a hint, never as proof, since anyone can put anything there.
      const fromQuery = new URL(request.url).searchParams.get("shop");
      return fromQuery ? fromQuery.replace(/^https?:\/\//, "") : undefined;
    }
  })();

  shopByRequest.set(request, pending);
  return pending;
}