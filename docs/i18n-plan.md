# CartGuard i18n + UI polish — plan

## Findings (from the repo)

- **Framework**: Remix 2.15 (Vite) + React 18. Embedded Shopify app via `@shopify/shopify-app-remix` 3.5, App Bridge React 4.2.
- **Polaris flavor**: React `@shopify/polaris` **13.9.5**. No web components. All pages already use React Polaris, so the app stays on that flavor.
- **Polaris ships locale files** for all 21 admin languages in `@shopify/polaris/locales/*.json`, and `AppProvider` accepts `i18n`. Polaris component strings need **zero new dependencies**.
- **Auth/sessions**: `shopifyApp({ sessionStorage: new PrismaSessionStorage(prisma) })`, Prisma 5 + Postgres, model `Session` per staff member.
- **`Session.locale` already exists** but it is the *admin user's* locale, not a merchant preference, and is per staff member, not per shop. A new per-shop row is needed.
- **ORM/DB**: Prisma. New model only; no change to `Session`, auth, billing or webhooks.
- **Existing i18n**: none, except `auth.login.tsx` passing `en.json` to Polaris.
- **Strings**: hardcoded in `root.tsx`, `app.tsx`, `app._index.tsx`, `app.rules.tsx`, `app.orders.tsx`, `app.settings.tsx`, `privacy.tsx`, `auth.login.tsx`, `components/rule-fields.tsx`, `components/section-status.tsx`, `lib/rule-summary.ts`, `lib/rule-editor.ts`, `lib/cartguard.server.ts`, `lib/validation.server.ts`, `lib/regions.ts`. ~4.7k lines total.
- **Styling**: Tailwind 3.4 + raw Polaris CSS. Tailwind appears only in `root.tsx` (error page) and for hero card backgrounds. **Polaris 13 is dark-mode ready**: it exposes `p-theme-dark-experimental` and all tokens as CSS variables (`--p-color-*`, `--p-space-*`, `--p-shadow-*`).
- **Extensions**: one Checkout Function (`cartguard-validator`), **no theme app and no checkout UI extension**. It has no locale files and needs none — it returns no UI, only validation errors. Verified in `shopify.extension.toml`.

## Library decision

- **Polaris component strings** → Polaris's own bundled locale JSON via `AppProvider i18n`. No dependency.
- **App strings** → a small typed message catalog (`app/i18n/`) with `Intl.PluralRules` and `Intl` formatting. No dependency.
- **Why not i18next/react-i18next**: the app has ~250 strings, a single runtime locale per shop, and must render identically on SSR and after hydration. i18next adds ~40 kB plus a client-only rehydration story for no gain; its advantages (language auto-detection, lazy loading, CDN backends) are either handled by Polaris already or unused. A typed catalog also makes the missing-key test trivial and compile-time checked via `keyof Messages`.
- **Only new dependency**: `flag-icons` (CSS-only SVG flags) — justified because emoji flags render as plain letters on Windows, and hand-inlining 10 flags would mean maintaining raw path data.
- Locale codes deliberately match Polaris's own (`pt-BR`, `zh-CN`) so one code drives both the app catalog and the Polaris catalog.

## Languages

Required: `en` (default/fallback), `de`, `fr`, `es`, `pt-BR`, `zh-CN`, `ja`.
Research-based additions (≤3): `it`, `nl`, `sv`.

- **pt-BR over pt-PT**: Brazil has ~73k–122k Shopify stores (Built With / Store Leads / Cropink) and is a top-8 Shopify market; Portugal appears in no top-15 Shopify market list. Polaris ships `pt-BR.json` for the admin.
- **it** — 44,577 (Built With) / ~56k (Store Leads) stores; GDP per capita $46,505 (Worldometers/IMF, 2025). Admin supports Italian.
- **nl** — 53,193–67,481 stores; GDP per capita $79,918 (Worldometers/IMF, 2025), highest of the candidates. Admin supports Dutch.
- **sv** — ~23,900 stores; GDP per capita $56,748 (World Economics, 2025). Admin supports Swedish.
- **ko skipped**: Korea has only ~3,560 Shopify stores despite high GDP, so it fails the "large number of stores + high income" hypothesis.
- **RTL skipped**: no RTL language added; the app has no RTL layout support today.

## Files

New:
- `prisma/schema.prisma` — add `ShopPreference` model (shop, language, languageChosenAt).
- `app/i18n/index.ts` — supported locales, native names, flags, normalisation/mapping, `t()`/`formatNumber`/`formatDate`/plural.
- `app/i18n/messages/{en,de,fr,es,pt-BR,zh-CN,ja,it,nl,sv}.json` — the catalogs.
- `app/i18n/language.server.ts` — per-shop preference read/write, detect `?locale=` and `Session.locale`.
- `app/i18n/context.tsx` — `I18nProvider` + `useI18n`; sets `document.documentElement.lang`, Polaris `i18n`.
- `app/components/language-switcher.tsx` — Polaris `Select` with SVG flag.
- `app/components/onboarding-language.tsx` — first-run modal.
- `app/components/app.css` — the only custom CSS, scoped `.cg-*`, tokens only, `prefers-reduced-motion` guarded.
- `tests/i18n.test.ts` — missing-key, placeholder parity, plural and fallback tests.
- `scripts/check-locales.mjs` — CLI form of the same check, wired into `npm test`.

Modified: every route/component/lib listed above, plus `package.json` and `tailwind.config.ts`.

## Risks

1. **Hydration mismatch / wrong-language flash.** Mitigated by resolving the language on the server per shop and passing it through the root loader; `<html lang>` is set server-side, and the client only overrides after an explicit user choice.
2. **Plurals** — Japanese and Chinese have one plural form. `Intl.PluralRules` per locale handles this, and the catalog test checks placeholder parity across all languages.
3. **Tailwind `slate-*` classes are hardcoded light colours.** The error page is rewritten to Polaris so no hardcoded colour survives.
4. **Demo mode** has no session, so locale detection falls back to `?locale=` / `Accept-Language` there.
5. **Long German/French strings** — no fixed widths anywhere, flags are `flex: none`, and the catalog test flags strings over 90 characters for manual layout review.
