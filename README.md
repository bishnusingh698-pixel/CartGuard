# CartGuard

Fraud prevention at checkout with a **Shopify Function** (`cart.validations.generate.run`, API **2026-07**) and a **Remix + Polaris** admin for configuring rules and checking their impact before saving.

## How it works

- **Rules** are stored in app-owned shop metafields (`$app:cartguard`, type `json`): `settings`, `regex_rules`, `quantity_limits`, `geo_blocklist`, `vip_allowlist`.
- **Checkout rule**: saving creates or enables a Shopify Validation for the `cartguard-validator` Function (`blockOnFailure: false`) and writes its `function-configuration` metafield (`{ "limitTags": [...] }`), which feeds `product.hasTags` in the input query.
- **One rule engine**: `extensions/cartguard-validator/src/rules.ts` is used by both the Function and the Impact Checker.
- **Rule order**: blocked countries (applies to VIPs too) → VIP bypass → quantity and order amount limits → address rules → ZIP/city/province.
- **Order limits**: each limit can set a minimum and/or a maximum number of units, plus a minimum and/or maximum order total. Amount bounds belong to the "every product" limit and apply to the whole order.
- **Sessions**: Prisma + Postgres (`DATABASE_URL`), migrations in `prisma/migrations`.
- **Webhooks** (`/webhooks`): `app/uninstalled` and `shop/redact` delete sessions, `customers/redact` removes the customer from the VIP allowlist, `customers/data_request` reports matches, `app/scopes_update` updates the session scope.

## Environment

See `.env.example`: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `DATABASE_URL`. The app refuses to start if any required value is missing.

## Commands

```bash
npm install
npm run function:install   # Function dependencies
npm run function:schema    # download Shopify's real Function schema (commit schema.graphql)
npm test                   # rule engine + Function output tests
npm run typecheck
npm run deploy             # shopify app deploy (app config + Function)
```

## Hosting (Render)

`render.yaml` builds with `npm install --include=dev && npm run build` and starts with `prisma migrate deploy && remix-serve`. On the free plan, point an uptime pinger at `/api/ping` every 5-10 minutes.
