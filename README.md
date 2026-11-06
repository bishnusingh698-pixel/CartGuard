# CartFence

Blocks risky carts at checkout. A Shopify Function evaluates the rules inside
Shopify, and a Remix admin lets the merchant configure them and preview the
effect on recent orders before saving.

> **Formerly CartGuard.** A few identifiers keep the old name on purpose, because
> changing them would break stores that already have the app installed: the
> metafield namespace (`$app:cartguard`, plus the legacy `cartguard`), the
> Function handle (`cartguard-validator`), the Render service name and its
> `cartguard-co1f.onrender.com` URL, and two browser storage keys for the setup
> guide. Everything merchants see says CartFence.

## What merchants can block

- Countries, states, cities and postal codes
- Products that can't ship to some countries: products with a tag (such as
  batteries, liquids or alcohol) can't be sent to the countries chosen for it
- Addresses: PO Boxes, US military addresses, a missing house or building
  number, blocked words and specific streets
- Order quantities: minimum and maximum units per product, pack sizes
  ("sold in packs of 6"), fewest and most items per order (all products
  together) and minimum or maximum order value
- Email addresses: blocked email domains and well-known throwaway email
  services. Only domains are stored, never a customer's email
- Trusted customers (by account email, street address or customer tag such as
  `wholesale`) skip the rules above, except blocked countries and product
  shipping rules

The admin has three pages in order of use: Overview (status and a three-step
setup guide), Block rules (a step list, links to every section, templates
and a "Try a checkout" tester that runs unsaved rules on a typed address and
email) and Order check (the saved rules run on recent orders).

## Requirements

- Node 22 or newer
- A Shopify Partner account and a development store
- Shopify CLI (`npm run shopify` wraps it, or install it globally)
- A Postgres database, for session storage

## Setup

```bash
npm install
npm run function:install
cp .env.example .env    # fill in the values
npm run setup           # prisma generate
npm run db:deploy
```

Set `application_url` in `shopify.app.toml` to your tunnel URL, then run
`npm run dev`. The CLI prints a login link for the dev store on first run.

`automatically_update_urls_on_dev` is `false`, so `shopify app dev` will not
repoint the configured app. Use a separate app (`shopify app config link`) for
local development.

## Environment variables

Copy `.env.example` to `.env`. In development each value has a built-in
fallback, so the app boots without them. In production a missing
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` or `SHOPIFY_APP_URL` throws at startup
rather than failing on a later request.

| Variable | Purpose |
|---|---|
| `SHOPIFY_API_KEY` | App API key, from the Partner dashboard |
| `SHOPIFY_API_SECRET` | App API secret. Also signs webhook HMAC |
| `SHOPIFY_APP_URL` | Public app URL |
| `SCOPES` | Comma-separated. Defaults to `read_orders,read_products,write_validations` |
| `DATABASE_URL` | Postgres connection string. Required in production |

## Commands

```bash
npm run dev              # Remix dev server on :3000
npm run build            # production build
npm start                # serve the build
npm test                 # locale check plus vitest
npm run typecheck        # tsc
npm run lint             # eslint
npm run deploy           # shopify app deploy, app config and Function
```

Function tasks:

```bash
npm run function:schema    # refresh extensions/cartfence-validator/schema.graphql
npm run function:typegen   # regenerate Function input types
npm run function:build     # build the Function to wasm
```

## Layout

- `app/` — Remix admin: routes, components, i18n, server libs
- `extensions/cartfence-validator/src/rules.ts` — the rule engine. Imported by
  the Function and by the admin, so the order preview and the live checkout
  apply identical rules
- `prisma/` — schema and migrations for session and preference storage
- `tests/` — vitest suites covering the rule engine, privacy handlers and i18n

Rules and the VIP allowlist are saved as app-owned metafields in the merchant's
store, not in the app database. The database holds only session data and the
chosen admin language. See `app/routes/privacy.tsx` for the full statement.

## Deployment

`.npmrc` sets `include=dev`. Render builds with `NODE_ENV=production`, which
makes npm skip devDependencies, and the Vite build then dies on
`Cannot find module 'tailwindcss'` because `postcss.config.js` loads Tailwind.
The flag keeps the build working whatever build command is configured.

`render.yaml` describes the service: build `npm install && npm run build`, start
`npm run db:deploy && npm start` so schema changes apply on each boot, health
check `/api/ping`. Set `DATABASE_URL`, `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`
in the Render dashboard with `sync: false` so they are not committed. On the free
plan, point an uptime pinger at `/api/ping` every 5-10 minutes so the instance
does not sleep.

Note that `render.yaml` only applies if the service was created from the
blueprint. If the build and start commands are set in the Render dashboard
instead, keep them in step with the file.

The app is embedded (`embedded = true` in `shopify.app.toml`), so
`SHOPIFY_APP_URL` is the tunnel URL Shopify loads the admin inside.
