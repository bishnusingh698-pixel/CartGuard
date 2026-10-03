import type { HeadersFunction } from "@remix-run/node";

export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, max-age=3600",
});

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-slate-50 py-12 px-4 sm:px-6 lg:px-8 text-slate-800">
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-8 sm:p-12">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-4">CartGuard Privacy Policy</h1>
        <p className="text-sm text-slate-500 mb-8">Effective date: October 2026</p>

        <div className="space-y-6 text-sm leading-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">What we store</h2>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>
                <strong>Session data:</strong> your shop domain, the access token Shopify issues to
                CartGuard, and the permissions you granted. Required so the app can call Shopify on
                your behalf. Deleted when you uninstall CartGuard, and when Shopify sends a{" "}
                <code>shop/redact</code> request.
              </li>
              <li>
                <strong>Your admin language choice:</strong> the language you pick, tied to your shop
                domain. Deleted on uninstall or <code>shop/redact</code>.
              </li>
            </ul>
            <p className="mt-2">
              Those two items are all this app stores in its database. It holds no customer names,
              emails, addresses, phone numbers, or order contents.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Where your rules live</h2>
            <p>
              Your block rules, including any VIP allowlist entries you type, are saved as app-owned
              metafields in your own store. They are not copied into our database.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Data we read but don&apos;t store</h2>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>
                <strong>At checkout:</strong> rules run inside Shopify as a Shopify Function. The
                buyer&apos;s email, delivery address and cart are evaluated in memory and never reach
                our servers.
              </li>
              <li>
                <strong>Order check:</strong> when you run it, the app reads your 100 most recent
                orders (email, shipping address, products) to estimate how many your rules would stop.
                The result is shown to you and discarded; nothing is written to disk.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Privacy requests</h2>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>
                <strong>customers/data_request:</strong> we check whether the customer&apos;s email or
                street addresses match your VIP allowlist and report the match count to you. The
                addresses themselves are not logged.
              </li>
              <li>
                <strong>customers/redact:</strong> we remove any matching email or street address from
                your VIP allowlist.
              </li>
              <li>
                <strong>shop/redact:</strong> we delete all session data and preferences for your shop.
              </li>
            </ul>
            <p className="mt-2">
              Each request is verified with Shopify&apos;s HMAC signature before we act on it. The app
              holds no customer data of its own, so there is nothing further to delete.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Sharing</h2>
            <p>We do not sell or share personal data.</p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Contact</h2>
            <p>
              For privacy questions, email{" "}
              <a href="mailto:support@cartguard.io" className="text-blue-600 hover:underline">
                support@cartguard.io
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
