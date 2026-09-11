import type { HeadersFunction } from "@remix-run/node";
import { json } from "@remix-run/node";

export const headers: HeadersFunction = () => {
  return {
    "Cache-Control": "public, max-age=3600",
  };
};

export const loader = async () => {
  return json({ ok: true });
};

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-slate-50 py-12 px-4 sm:px-6 lg:px-8 text-slate-800">
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-8 sm:p-12">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-4">
          CartGuard Privacy Policy
        </h1>
        <p className="text-sm text-slate-500 mb-8">
          Effective Date: September 2026
        </p>

        <section className="space-y-6 text-sm leading-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">
              1. Overview
            </h2>
            <p>
              CartGuard operates as a native Shopify Functions application designed to provide
              checkout validation, PO Box/freight forwarder blocking, bulk quantity limits, and
              geographic delivery controls. We prioritize data minimization and do not collect,
              monetize, or sell any personal data of your store visitors or customers.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">
              2. Data Storage &amp; Architecture
            </h2>
            <p>
              CartGuard does not operate external databases that store your customer orders, names,
              or billing addresses. All rules and blocklists created by merchants are saved directly
              within the merchant’s own Shopify store using Shopify Shop Metafields under the
              &quot;cartguard&quot; namespace.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">
              3. Checkout Validation
            </h2>
            <p>
              Checkout validation runs entirely inside Shopify’s secure WebAssembly infrastructure
              (Shopify Functions). When an order is placed, customer address fields are evaluated in
              memory against the merchant’s configured rules in sub-5ms with zero external network
              transfers or outbound data leaks.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">
              4. GDPR &amp; Privacy Compliance
            </h2>
            <p>
              CartGuard responds to all mandatory Shopify compliance webhooks:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li><strong>customers/data_request:</strong> Handled automatically; no customer profiles are retained externally.</li>
              <li><strong>customers/redact:</strong> Handled automatically; no personally identifiable records are stored.</li>
              <li><strong>shop/redact:</strong> On app uninstallation or shop deletion, store sessions are immediately cleared.</li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">
              5. Contact Information
            </h2>
            <p>
              For privacy-related inquiries or technical support, please contact the developer at{" "}
              <a href="mailto:support@cartguard.io" className="text-blue-600 hover:underline">
                support@cartguard.io
              </a>.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
