import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

/**
 * Lightweight, zero-overhead health-check / ping endpoint.
 * Bypasses all Shopify authentication and heavy database calls so external
 * uptime monitors (Cron-Job, UptimeRobot, BetterStack) can ping every 5-10 minutes
 * to keep Render's free instance permanently warm and prevent the 30-50s cold start.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return json(
    {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      service: "cartguard",
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Content-Type": "application/json",
      },
    }
  );
};
