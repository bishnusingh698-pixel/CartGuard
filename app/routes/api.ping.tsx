import { json } from "@remix-run/node";

/**
 * Health check / keep-alive endpoint for Render's health check and an external
 * pinger (UptimeRobot, cron-job.org, BetterStack). No auth, no database, so it
 * stays fast and cheap. Ping every 5-10 minutes to stop the free instance from
 * sleeping after 15 minutes of inactivity.
 */
export const loader = async () => {
  return json(
    {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      service: "cartguard",
    },
    {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    },
  );
};
