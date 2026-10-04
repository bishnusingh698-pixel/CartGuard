# CartGuard

Shopify app (Remix + App Bridge) that blocks carts and checkouts by shipping
address, geography, order quantity, and order amount.

## Module boundaries

`*.server.ts` modules may only be imported by loaders, actions, and other server
code. Importing one from a route component's client bundle fails the production
build with `[commonjs--resolver] Server-only module referenced by client` — but
`tsc` and Vitest both pass, so always run `npm run build` before calling a change
done. Anything a client component needs (shared types, message rendering) goes
in a plain module such as `app/lib/message.ts` or `app/lib/rule-summary.ts`.

## Messages

Validation output is structured, never a finished English string. Messages are a
`{ key, values }` pair from `app/lib/rule-summary.ts`, resolved for the reader's
language by `resolveMessage` in `app/lib/message.ts`. Catalog wording lives in
`app/i18n/messages/*.json`.

Every locale must carry the same key set and the same placeholder names as
English. Placeholder *order* legitimately differs in ja and zh-CN; the name set
must not. Adding a key means adding it to all ten catalogs — `tests/i18n.test.ts`
enforces both halves.

Casing is a catalog concern, not a code concern. Strings shown mid-sentence
(`violation.detail.*`) and strings shown as standalone lines
(`violation.reason.*`) are separate keys so that ja/zh-CN, which have no
letter case, stay correct.

## Verify

    npm run typecheck && npm run lint && npm test && npm run build