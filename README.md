# CartGuard

Blocks risky carts at checkout. A Shopify Function evaluates the rules inside
Shopify, and a Remix admin lets the merchant configure them and preview the
effect on recent orders before saving.

## Requirements

- Node 20 or newer
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
npm run function:schema    # refresh extensions/cartguard-validator/schema.graphql
npm run function:typegen   # regenerate Function input types
npm run function:build     # build the Function to wasm
```

## Layout

- `app/` — Remix admin: routes, components, i18n, server libs
- `extensions/cartguard-validator/src/rules.ts` — the rule engine. Imported by
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
