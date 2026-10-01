import type { HeadersFunction } from "@remix-run/node";

export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, max-age=3600",
});

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-slate-50 py-12 px-4 sm:px-6 lg:px-8 text-slate-800">
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-8 sm:p-12">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-4">CartGuard Privacy Policy</h1>
        <p className="text-sm text-slate-500 mb-8">Effective date: September 2026</p>

        <section className="space-y-6 text-sm leading-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">1. Overview</h2>
            <p>
              CartGuard is a Shopify app that validates carts and checkouts (PO Box and military
              address blocking, quantity and order amount limits, geographic restrictions and a
              VIP allowlist). We
              don&apos;t sell or share personal data.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">2. Data we store</h2>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>
                <strong>Store session:</strong> your shop domain, the access token Shopify issues to
                CartGuard and the granted permissions. It&apos;s kept in our database so the app can
                work, and deleted when you uninstall CartGuard or Shopify asks us to erase shop data.
              </li>
              <li>
                <strong>Your rules:</strong> saved in your own store as app-owned Shopify metafields. If
                you add customer email addresses or street addresses to the VIP allowlist, they are
                stored there.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">3. Data we read but don&apos;t store</h2>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>
                <strong>Checkout:</strong> rules run inside Shopify&apos;s infrastructure (Shopify
                Functions). The buyer&apos;s email, delivery address and cart are checked in memory and
                never sent to CartGuard&apos;s servers.
              </li>
              <li>
                <strong>Impact Checker:</strong> when you check or save rules, CartGuard reads up to
                your 100 most recent orders (email, shipping address, products) to estimate how many
                would have been blocked. This data is processed in memory and not stored.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">4. GDPR and privacy requests</h2>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>
                <strong>customers/data_request:</strong> we check whether the customer&apos;s email or
                addresses appear in your VIP allowlist and provide those entries to you on request.
              </li>
              <li>
                <strong>customers/redact:</strong> we remove the customer&apos;s email and addresses
                from your VIP allowlist.
              </li>
              <li>
                <strong>shop/redact:</strong> we delete all stored sessions for your shop.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">5. Contact</h2>
            <p>
              For privacy questions or support, email{" "}
              <a href="mailto:support@cartguard.io" className="text-blue-600 hover:underline">
                support@cartguard.io
              </a>
              .
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
