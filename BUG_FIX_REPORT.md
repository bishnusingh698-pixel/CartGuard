# CartGuard — Bug Audit & Fix Report

- **Branch:** `fix/full-bug-audit`
- **Base:** `feat/i18n-and-ui-polish`
- **Project type:** Shopify app (Remix + Prisma/Postgres + Polaris 13 + App Bridge 4) with a checkout Function extension. No theme/Liquid.
- **Date:** 2026-10-02

## Summary

| | Count |
|---|---|
| Bugs found | 3 |
| Fixed | 3 |
| Flagged for human review | 3 |
| False leads investigated and dismissed | 4 |

---

## Bugs fixed

| # | File | Line | Description | Severity | Status |
|---|---|---|---|---|---|
| 1 | `extensions/cartguard-validator/src/rules.ts` | 665 (`amountBounds`) | Order-amount bounds from **any** configured limit were applied to **every** cart, because `amountBounds` never consulted the limit's key. A rule scoped to a product tag became a store-wide blocker, and the tightest bound won regardless of relevance. | **High** | Fixed (`12e050e`) |
| 2 | `app/lib/cartguard.server.ts` | 666 (`simulateImpact`) | Pagination loop was bounded by `orders.length`, but a page returning zero orders never incremented it. A repeated cursor caused unbounded re-querying (40 requests in the reproduction) until the Admin API throttled. | **Medium** | Fixed (`dc8272d`) |
| 3 | `app/entry.server.tsx` | 28 (`sendResponse`) | The stream abort timer was only cleared in `onAllReady`, which runs for bots. On the streaming path it fired up to 6s later and aborted a render that had already been sent. | **Medium** | Fixed (`ad2989f`) |

### 1. Order-amount bounds ignored limit scoping — **High**

`amountBounds()` iterated `Object.values(limits)` and took the tightest `minAmount`/`maxAmount` found, never asking whether the limit's key matched anything in the cart.

Reproduction before the fix:

```
limits: { bulk: { minAmount: 50 } }
cart:   one $20 product tagged "sale"   →  BLOCKED  ("Orders need to be at least $50.00")
```

Worse, unrelated bounds could override a legitimate global one:

```
limits: { all: { minAmount: 10 }, premium: { minAmount: 9000 } }
cart:   one $10 ordinary product       →  BLOCKED  (against the $9,000 minimum)
```

The blast radius is a merchant's whole store: a rule intended for one product class silently stopped checkout for everyone.

**Why this is unambiguously a bug, not a design choice.** The codebase already treats an amount bound on a scoped limit as invalid data, in two independent places:

- `app/lib/rule-editor.ts:60-62` — *"the amount bounds apply to the whole order and are only offered on the 'Every product' row"*
- `app/lib/cartguard.server.ts:243-246` — *"order amounts only apply to the 'Every product' limit"*, which **rejects the config** on save
- `app/routes/app.rules.tsx:375` only renders the amount inputs when `row.target === "all"`

So the editor and the validator both prevent the input, and only the Function silently acted on it. The engine now agrees with the other three layers.

**Fix:** `amountBounds(cart, limits)` now takes the cart and only considers limits that match something in it, via a new `matchingLimitEntries()`. The per-product aggregation was extracted from `evaluateQuantityLimits` into `aggregateProducts()` so the quantity and amount paths share one implementation and cannot drift apart again.

**Note on an existing test.** `tests/rules.test.ts` had a case "uses the tightest amount bound when several limits set one" that passed *only because of this bug*: its fixture line carried `tags: []` while the rule was keyed `bulk`, so under correct behaviour nothing would match. The test's stated intent — the tightest matching bound wins — is sound and has been kept, with the fixture corrected to actually carry the `bulk` tag. Flagged in case the original author intended something different.

### 2. Impact Checker re-queried on an unadvancing cursor — **Medium**

```js
while (orders.length < IMPACT_MAX_ORDERS) { ... }
```

If `hasNextPage` was true but the page contained no `nodes`, the loop counter never moved. Combined with a cursor Shopify repeated, this issued identical paged queries indefinitely. The reproduction made 40 requests before the mock ran out; against the real API it would keep going until throttled, surfacing an error to the merchant.

**Fix:** break when the returned cursor has been seen before, or when a page yields no orders. Distinct-cursor pagination, the 100-order cap, and the throttle-budget check are unchanged.

### 3. Stream abort timer not cleared on the streaming path — **Medium**

`abortTimer` was cleared in `onAllReady` (bots) and `onShellError`, but not in `sendResponse`. For non-bot requests the response is sent from `onShellReady`; if the tail never completed, `onAllReady` never ran and the timer fired up to six seconds later, calling `abort()` on a render already handed to the client — tearing down the stream mid-transfer.

**Fix:** clear the timer in `sendResponse`, which both paths go through.

---

## Needs human review

These are **not fixed**. Each either changes intended behaviour or is a judgement call about product/security posture that I did not want to make unilaterally.

| # | Location | Issue | Why I did not fix it |
|---|---|---|---|
| A | `app/i18n/locales.ts` `ALIASES` | A corrupt `ShopPreference.language` row (junk string) reads back as `chosen: true`, so the merchant is never re-prompted to choose a language. | Making it re-prompt risks an infinite onboarding loop on every page load if the corruption is persistent. Which failure mode you prefer is a product decision. |
| B | `package.json` → `flag-icons` | Installed dependency is never imported. `LANGUAGE_OPTIONS.flag` and `LANGUAGE_FLAGS` are dead data, and the `flag` field's comment claims it renders an SVG "from `flag-icons`" and is "`aria-hidden` in the UI" — neither is true. | Either the flag UI was dropped and the data should go, or it was meant to be built. Removing a dependency or building a UI element is beyond a bug fix. |
| C | `app/routes/api.ping.tsx` | Unauthenticated endpoint returns `uptime` and `service: "cartguard"`. Minor fingerprinting / load-state disclosure. | Documented as intentional for Render health checks and external uptime pinging. Adding auth would break those. Worth deciding whether uptime belongs in a public payload. |

### Correction: an earlier draft flagged `maxAmount` semantics, wrongly

An intermediate version of this report listed as a suspected bug that `maxAmount` is compared against the whole cart total, and therefore blocks multi-item carts more readily than single expensive items. **That is not a bug, and I withdrew the item** after testing it:

```
limits: { all: { maxAmount: 500 } }
1 × $600 product            → blocked   (total 600)
10 × $40 products           → allowed   (total 400)
20 × $40 products           → blocked   (total 800)
```

`cartTotal()` sums line prices and compares against the order total, which is exactly what the UI label says: *"Order total must be at most"*. The behaviour is consistent and correctly labelled. Recorded here so the withdrawn concern is not re-raised later.

---

## Commands run and results

Baseline was taken on `feat/i18n-and-ui-polish` before any changes.

| Command | Before | After |
|---|---|---|
| `npx tsc` | pass | pass |
| `npm run lint` | 0 errors (5 Remix future-flag warnings) | 0 errors (same warnings) |
| `npm test` (`check-locales` + vitest) | 9 files, 137 tests pass | **10 files, 144 tests pass** |
| `npm run build` | pass | pass |
| `npx tsc --noEmit` (function ext.) | pass | pass |
| `npm audit` | 21 vulns (2 critical, 12 high) | unchanged — see below |

### On `npm audit`

21 advisories, of which **2 critical / 12 high**. All are transitive and either dev-only or have no non-breaking fix:

- `tar`, `cacache`, `esbuild`, `vite`, `vitest` — build/test toolchain only, never shipped to production.
- `@remix-run/*` + `turbo-stream` — the DoS advisory (`GHSA-rxv8-25v2-qmq8`) requires **single-fetch** to be enabled. It is not: `grep` for `singleFetch`/`future` in `vite.config.ts` and `entry.server.tsx` returns nothing.
- `@shopify/shopify-app-remix` — the only "fix" offered is a **downgrade** to 3.3.1, which is the wrong direction.

**I deliberately did not run `npm audit fix --force`.** It would force a Remix v7 / React Router migration and a major Prisma/Shopify bump — a large, behaviour-changing change that is explicitly out of scope for a bug-fix pass and could break the working auth and session handling. This is the one item I would raise as separate work.

---

## Investigated and found sound

Recording these so the next pass doesn't re-audit them:

- **Secrets** — `.env` is gitignored and was never committed (`git log --all --diff-filter=A -- .env` is empty). `shopify.app.toml` contains only a public client ID.
- **XSS** — exactly one `dangerouslySetInnerHTML` in the codebase; it renders a static template literal with no interpolation, gated behind `isMock`. No `innerHTML`, `eval`, or `new Function` in app or function source.
- **Demo-mode auth bypass** — `canUseMockAdmin` returns `false` when `NODE_ENV === "production"`, and `db.server.ts` throws at boot in production without `DATABASE_URL`. Both covered by existing tests in `hardening.test.ts`.
- **Webhooks** — `authenticate.webhook` (HMAC) runs before any handling; non-`Response` errors return 500 so Shopify retries; `Response`s are re-thrown so the 401 survives. `APP_UNINSTALLED` and `SHOP_REDACT` both delete sessions.
- **Rule engine vs. hostile input** — probed with 18 malformed configs (prototype-key presets, unbalanced regex, `(a+)+` ReDoS, 500KB patterns, non-string blocklists, `NaN`/negative/zero limits, `null` product IDs, huge `min`). All rejected without throwing; `evaluateCart` additionally wraps each rule in a fail-open `try/catch`. No changes needed.
- **VIP guest spoofing** — `isVipCustomer` only reads `customerEmail` (the account email from `buyerIdentity.customer.email`), never the freely-typed `buyerIdentity.email`. Verified a guest typing a VIP address is still blocked.
- **Country embargo vs. VIP** — `evaluateCart` runs the embargo *before* the VIP short-circuit, so a VIP in a blocked country is still stopped. This is the behaviour the Settings copy promises.

---

## Remaining known issues

1. The 21 `npm audit` advisories need a dependency-modernisation branch (see above).
2. Items A–C in "Needs human review".
3. `render.yaml` and the production Postgres provisioning were out of scope and were **not** verified against a live deployment.
4. I did not test against a real Shopify store. The Function was verified by unit tests and typecheck only; **it has not been run through `shopify app function build` to produce `dist/index.wasm`**, because that needs the Shopify CLI authenticated against a store.
