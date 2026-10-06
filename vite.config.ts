import { vitePlugin as remix } from "@remix-run/dev";
import { installGlobals } from "@remix-run/node";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

installGlobals();

// The Shopify CLI passes the tunnel URL as HOST; the app reads SHOPIFY_APP_URL.
if (process.env.HOST && (!process.env.SHOPIFY_APP_URL || process.env.SHOPIFY_APP_URL === process.env.HOST)) {
  if (process.env.HOST.startsWith("http://") || process.env.HOST.startsWith("https://")) {
    process.env.SHOPIFY_APP_URL = process.env.HOST;
  }
}

// Vite rejects requests whose Host header it doesn't know, which would block
// the Shopify CLI tunnel in development.
let appHost: string | undefined;
try {
  appHost = process.env.SHOPIFY_APP_URL ? new URL(process.env.SHOPIFY_APP_URL).hostname : undefined;
} catch {
  appHost = undefined;
}

export default defineConfig({
  server: {
    host: "0.0.0.0",
    // `shopify app dev` picks a free port and passes it as PORT.
    port: Number(process.env.PORT || 3000),
    strictPort: true,
    allowedHosts: appHost && appHost !== "localhost" ? [appHost] : undefined,
    hmr: false,
    fs: {
      // The admin imports the shared rule engine from the Function source.
      allow: ["app", "node_modules", "extensions/cartguard-validator/src"],
    },
  },
  plugins: [remix({ ignoredRouteFiles: ["**/.*"] }), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
}) satisfies UserConfig;
