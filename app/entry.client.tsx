import { RemixBrowser } from "@remix-run/react";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

if (typeof window !== "undefined") {
  if (!(window as unknown as { shopify?: unknown }).shopify) {
    (window as unknown as { shopify: unknown }).shopify = {
      toast: {
        show: (msg: string) => {
          console.log("[CartGuard Toast]", msg);
        },
      },
      environment: { embedded: false },
      config: { apiKey: "cartguard-dev-api-key" },
    };
  }

  const elements = ["ui-nav-menu", "ui-title-bar", "ui-save-bar", "ui-modal"];
  elements.forEach((tag) => {
    if (!customElements.get(tag)) {
      try {
        customElements.define(tag, class extends HTMLElement {});
      } catch {
        // Element already registered or environment constraint
      }
    }
  });
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <RemixBrowser />
    </StrictMode>
  );
});
