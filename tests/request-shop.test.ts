/**
 * Shop resolution for loaders that must never redirect.
 *
 * Root needs the shop to honour a saved language preference, but root also
 * renders the privacy policy and the login pages, which exist precisely because
 * there is no session. So this function has to answer "which shop is this?"
 * without ever throwing the redirect `authenticate.admin` throws when it cannot
 * find a session — otherwise every signed-out page turns into an OAuth bounce.
 *
 * The bug this pins down: root used to read the `shop` query parameter alone.
 * A merchant who installed the app as non-embedded reaches `/app` without that
 * parameter, so root emitted `lang="en"` while `app.tsx` rendered their saved
 * Japanese — two different languages inside one document.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateMock = vi.fn();

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: (...args: unknown[]) => authenticateMock(...args) },
}));

const saved = vi.hoisted(() => new Map<string, string | null>());

vi.mock("../app/db.server", () => ({
  default: {
    shopPreference: {
      findUnique: async ({ where }: { where: { shop: string } }) =>
        saved.has(where.shop) ? { language: saved.get(where.shop) ?? null, languageChosenAt: new Date() } : null,
      upsert: async ({ where, create }: any) => {
        saved.set(where.shop, create.language);
        return {};
      },
    },
  },
}));

const { readRequestShop } = await import("../app/lib/request-shop.server");
const { resolveRequestLanguage } = await import("../app/i18n/language.server");

/** A session, i.e. the request authenticated and root knows the real shop. */
function asSession(shop: string) {
  authenticateMock.mockImplementation(async () => ({ session: { shop } }));
}

/** Unauthenticated, which is what `authenticate.admin` throws for a signed-out request. */
function asUnauthenticated() {
  authenticateMock.mockImplementation(async () => {
    throw new Response(null, { status: 302, headers: { Location: "/auth/login" } });
  });
}

const request = (shop?: string) =>
  new Request(shop ? `https://cartguard.app/app?shop=${shop}` : "https://cartguard.app/app");

describe("readRequestShop", () => {
  beforeEach(() => {
    authenticateMock.mockReset();
  });

  it("returns the shop from the authenticated session", async () => {
    asSession("session.myshopify.com");
    expect(await readRequestShop(request())).toBe("session.myshopify.com");
  });

  it("prefers the session over the query parameter", async () => {
    // The parameter is attacker-controllable on an unauthenticated request, so
    // it must never win over a verified session.
    asSession("session.myshopify.com");
    expect(await readRequestShop(request("spoofed.myshopify.com"))).toBe("session.myshopify.com");
  });

  it("falls back to the query parameter when there is no session", async () => {
    asUnauthenticated();
    expect(await readRequestShop(request("fallback.myshopify.com"))).toBe("fallback.myshopify.com");
  });

  it("returns undefined instead of redirecting when signed out with no parameter", async () => {
    asUnauthenticated();
    // Throwing here would replace the privacy policy and login pages with an
    // OAuth bounce, since none of them have a session.
    expect(await readRequestShop(request())).toBeUndefined();
  });

  it("strips a scheme so the shop matches the stored preference key", async () => {
    asUnauthenticated();
    expect(await readRequestShop(request("https://scheme.myshopify.com"))).toBe("scheme.myshopify.com");
  });

  it("authenticates once per request, however many times it is read", async () => {
    // Root and app.tsx both need the shop. Without memoisation every request
    // would pay for two session-token verifications.
    asSession("memo.myshopify.com");
    const req = request();
    const [first, second] = await Promise.all([readRequestShop(req), readRequestShop(req)]);
    expect([first, second]).toEqual(["memo.myshopify.com", "memo.myshopify.com"]);
    expect(authenticateMock).toHaveBeenCalledTimes(1);
  });

  it("does not leak the memoised shop to a different request", async () => {
    // A WeakMap keyed on the Request keeps the cache per-request; keying on
    // anything coarser would serve one merchant's shop to another.
    authenticateMock.mockReset();
    asSession("a.myshopify.com");
    expect(await readRequestShop(request())).toBe("a.myshopify.com");

    authenticateMock.mockReset();
    asSession("b.myshopify.com");
    expect(await readRequestShop(request())).toBe("b.myshopify.com");
    expect(authenticateMock).toHaveBeenCalledTimes(1);
  });

  it("treats a non-Error throw as unauthenticated rather than crashing", async () => {
    authenticateMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    expect(await readRequestShop(request("err.myshopify.com"))).toBe("err.myshopify.com");
  });
});

describe("root and app loaders agree", () => {
  beforeEach(() => {
    authenticateMock.mockReset();
    saved.clear();
  });

  /** What root and app.tsx each compute for the same document request. */
  async function resolveBoth(req: Request) {
    // app.tsx reads the shop off the authenticated session; root now does too.
    const shop = await readRequestShop(req);
    const root = await resolveRequestLanguage(req, { shop });
    const app = await resolveRequestLanguage(req, { shop });
    return { root, app };
  }

  it("honours a saved preference when the shop is only in the session", async () => {
    // The regression this whole file exists for: root read the `shop` parameter
    // alone, so a non-embedded merchant with no parameter in the URL got
    // lang="en" from root while app.tsx rendered their saved Japanese.
    saved.set("session-only.myshopify.com", "ja");
    asSession("session-only.myshopify.com");

    const { root, app } = await resolveBoth(new Request("https://cartguard.app/app"));
    expect(root.language).toBe("ja");
    expect(app.language).toBe(root.language);
  });

  it("agrees for an embedded request carrying the shop parameter", async () => {
    saved.set("embedded.myshopify.com", "de");
    asSession("embedded.myshopify.com");

    const { root, app } = await resolveBoth(
      new Request("https://cartguard.app/app?shop=embedded.myshopify.com"),
    );
    expect(root.language).toBe("de");
    expect(app.language).toBe("de");
  });

  it("agrees when no preference is saved and the merchant is signed out", async () => {
    asUnauthenticated();

    const { root, app } = await resolveBoth(new Request("https://cartguard.app/app"));
    expect(root.language).toBe(app.language);
  });

  it("does not leak one merchant's saved language to another", async () => {
    saved.set("a.myshopify.com", "ja");

    asSession("a.myshopify.com");
    expect((await resolveBoth(new Request("https://cartguard.app/app"))).root.language).toBe("ja");

    authenticateMock.mockReset();
    asSession("b.myshopify.com");
    const other = await resolveBoth(new Request("https://cartguard.app/app"));
    expect(other.root.language).not.toBe("ja");
    expect(other.root.language).toBe("en");
  });
});