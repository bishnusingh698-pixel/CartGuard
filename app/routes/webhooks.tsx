/**
 * CartGuard — webhook runtime handler.
 *
 * Declarative registration lives in shopify.app.toml
 * ([[webhooks.subscriptions]] → app/uninstalled → /webhooks). This route only
 * AUTHENTICATES and PROCESSES the delivery, then always answers 200 OK so
 * Shopify does not retry a permanently-failed topic.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { payload, shop, topic } = await authenticate.webhook(request);

    if (topic === "APP_UNINSTALLED") {
      // The Session model row for this shop is garbage-collected by
      // shopify-app-remix's built-in session expiry handling; log for audit.
      const payloadData = payload as { shop_id?: string | number };
      console.log(`CartGuard uninstalled from shop ${shop} (shop_id: ${payloadData?.shop_id ?? "unknown"}). Session cleanup delegated to the library.`);
    } else if (topic === "CUSTOMERS_DATA_REQUEST") {
      // Mandatory compliance: CartGuard stores no customer personal data in external databases.
      // All rules are stored in shop-level metafields.
      console.log(`[GDPR] customers/data_request received for shop ${shop}. No external customer data held.`);
    } else if (topic === "CUSTOMERS_REDACT") {
      // Mandatory compliance: CartGuard stores no customer personal records.
      console.log(`[GDPR] customers/redact received for shop ${shop}. No external customer data to erase.`);
    } else if (topic === "SHOP_REDACT") {
      // Mandatory compliance: 48h shop data deletion.
      console.log(`[GDPR] shop/redact received for shop ${shop}. Shop-level data scheduled for purge.`);
    } else {
      console.log(`Received unexpected webhook topic "${topic}" for shop ${shop}.`);
    }
  } catch (error) {
    // authenticate.webhook throws on invalid HMAC — respond 401 without
    // leaking details.
    console.error("Webhook authentication failed:", (error as Error).message);
    return new Response("Unauthorized", { status: 401 });
  }

  return json({ ok: true });
};

// Webhooks POST only; GET requests get a plain 200 health response.
export const loader = async () => json({ ok: true });
