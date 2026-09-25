/**
 * CartGuard webhook handler (app/uninstalled, app/scopes_update and the three
 * mandatory compliance topics). Subscriptions are declared in shopify.app.toml.
 *
 * - Invalid HMAC: authenticate.webhook throws a 401 Response, returned as-is.
 * - Processing errors return 500 so Shopify retries the delivery.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  type CustomerPrivacyPayload,
  findCustomerInAllowlist,
  redactCustomerFromAllowlist,
} from "../lib/privacy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin, session } = await authenticate.webhook(request);

  try {
    switch (topic) {
      case "APP_UNINSTALLED": {
        // Removes stored offline tokens. Idempotent, so retries are safe.
        await db.session.deleteMany({ where: { shop } });
        console.log(`[webhooks] ${shop} uninstalled CartGuard; sessions deleted.`);
        break;
      }

      case "APP_SCOPES_UPDATE": {
        const current = (payload as { current?: unknown }).current;
        if (session && Array.isArray(current)) {
          await db.session.updateMany({
            where: { id: session.id },
            data: { scope: current.map(String).join(",") },
          });
        }
        break;
      }

      case "CUSTOMERS_DATA_REQUEST": {
        const data = payload as CustomerPrivacyPayload;
        if (!admin) {
          console.log(`[GDPR] customers/data_request for ${shop}: app not installed, no data accessible.`);
          break;
        }
        const matches = await findCustomerInAllowlist(admin, data);
        // Logged without the email itself. The merchant can be sent the
        // matching VIP entries on request.
        console.log(
          `[GDPR] customers/data_request for ${shop}, customer ${data.customer?.id ?? "unknown"}: ${matches} VIP allowlist entr${matches === 1 ? "y" : "ies"} found.`,
        );
        break;
      }

      case "CUSTOMERS_REDACT": {
        const data = payload as CustomerPrivacyPayload;
        if (!admin) {
          console.log(`[GDPR] customers/redact for ${shop}: app not installed, no data accessible.`);
          break;
        }
        const removed = await redactCustomerFromAllowlist(admin, data);
        console.log(
          `[GDPR] customers/redact for ${shop}, customer ${data.customer?.id ?? "unknown"}: removed ${removed} VIP allowlist entr${removed === 1 ? "y" : "ies"}.`,
        );
        break;
      }

      case "SHOP_REDACT": {
        await db.session.deleteMany({ where: { shop } });
        console.log(`[GDPR] shop/redact for ${shop}: all stored sessions deleted.`);
        break;
      }

      default:
        console.warn(`[webhooks] Unhandled topic "${topic}" for ${shop}.`);
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error(`[webhooks] Failed to process ${topic} for ${shop}:`, error);
    return new Response("Webhook processing failed", { status: 500 });
  }

  return new Response(null, { status: 200 });
};
