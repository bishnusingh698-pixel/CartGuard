# CartGuard

Fraud prevention at checkout via **Shopify Functions** (`purchase.validation.run`, API **2026-07**), with a **Remix + Vite + Polaris v13** admin for configuring rules and previewing their impact before saving.

## Architecture

| Constraint | Implementation |
|---|---|
| API version | `2026-07` (shopify.app.toml webhooks + `shopify.server.ts`) |
| Bundler | Vite (`vite.config.ts`) — no `remix.config.js` |
| Node | `>=20.0.0` |
| Session storage | Prisma + SQLite (`prisma/schema.prisma`, `app/db.server.ts`) |
| App data | **No external database** — all config lives in Shop Metafields, namespace `cartguard`, type `single_line_text_field`, values are stringified JSON |
| Webhooks | Declared in `shopify.app.toml` (`app/uninstalled` → `/webhooks`); runtime handler in `app/routes/webhooks.tsx` |
| Function export | `run` (pinned in `shopify.extension.toml`) |
| Function input query | `src/run.graphql` (shop metafields aliased under `shop { … }`) |
| WASM output | `dist/index.wasm` |
| Error shape | `{ localizedMessage: string, target: string }` |
| Return format | Wrapped: `{ operations: [{ validationAdd: { errors } }] }` — the direct `{ errors }` shape was attempted first and **failed to type-check** (see worklog evidence) |
| Admin UI | React Fragment parents (`<>`) — no `<Frame>`; per-button loading states |

## Metafield contract (Shop owner, namespace `cartguard`)

| Key | JSON shape |
|---|---|
| `settings` | `{ enable_vip, enable_po_box, enable_quantity, enable_geo, enable_mismatch }` |
| `regex_rules` | `[{ pattern, message? }]` |
| `quantity_limits` | `{ tag: max }` |
| `geo_blocklist` | `{ zips: [], cities: [], states: [] }` |
| `vip_allowlist` | `[email-or-address]` |

Missing/malformed values ⇒ feature disabled (fail-open). A fresh install is inert by design.

## Rule pipeline (evaluation order)

1. **VIP Allowlist** — checked first; match ⇒ zero errors immediately.
2. **Bulk Quantity Limiter** — all buyerJourney steps; per-product quantity aggregation by tag.
3. **PO Box / Freight Forwarder Blocker** — regex on address1/address2, `CHECKOUT_COMPLETION` only.
4. **Geographic Zone Blocker** — zip/city/provinceCode text matching across **every** delivery group.
5. **Smart Mismatch Detector** — high-risk pattern + differing billing address (null billing ⇒ skipped).

Every feature is individually try/catch-isolated; invalid regexes are skipped; the whole run is umbrella-protected. CartGuard must never crash checkout.

## Impact Checker

"Save" runs the simulator against the last 100 orders (Admin GraphQL) **before** persisting. Non-zero projected impact shows a warning banner + explicit "Save anyway" confirmation; then `metafieldsSet` (with `ownerId` from `shop.id`) writes the five metafields.

## Commands

```bash
npm install                      # root deps
npx prisma generate              # session storage client
npm run typecheck                # TEST 1 — whole repo
npm run test:function            # TEST 2 — typegen + esbuild + Javy → dist/index.wasm
npm run dev                      # shopify app dev
npm run deploy                   # shopify app deploy
```

## Extension build internals

- `shopify.extension.toml` keeps `[extensions.build] command = ""` — the CLI runs its own JS pipeline (typegen → esbuild → Javy). Setting `command = "npm run build"` while the extension build script invokes `shopify app function build` recurses infinitely (verified).
- `typegen_command = "npm run codegen"` runs `graphql-codegen --config codegen.json` against the committed `input-schema.graphql` → `generated/api.ts` (gitignored).
- The output contract is committed in `src/function-result.ts`; `@shopify/shopify_function` is pinned `^2.0.1` (the CLI validates `~2.0.x`; `^3.0.0` does not exist on npm).
- `src/index.ts` is the conventional bundler entry re-exporting `run` from `src/run.ts`.

## Deploy checklist

1. Fill `client_id`, `application_url`, `dev_store_url` in `shopify.app.toml`.
2. `npm install && npx prisma generate`.
3. `npm run test:function` — verify `dist/index.wasm` builds.
4. `npm run deploy`, then enable **CartGuard Validator** under Settings → Checkout → Customizations.
5. Grant protected customer data access (Function reads `cart.buyerIdentity.email`).

## Maintenance notes

- `app/lib/cartguard.server.ts` mirrors `src/run.ts` rule semantics for the Impact Checker — keep the two in sync when rules change.
- Admin API orders always expose billing addresses, so the Impact Checker simulates the mismatch rule fully; the checkout Function reads `cart.billingAddress` defensively (null ⇒ skipped, fail-open).
