/**
 * Exception paths in the `/language` action.
 *
 * Both guards here exist because the original version let each of these
 * rejections escape as a 500 ErrorBoundary, which replaces the entire app with
 * an error page instead of letting the picker show "could not save".
 */

import { describe, expect, it, vi } from "vitest";

const { failWrite } = vi.hoisted(() => ({ failWrite: { value: false } }));

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: "test.myshopify.com" } }),
  },
}));

vi.mock("../app/i18n/language.server", () => ({
  writeChosenLanguage: async () => {
    if (failWrite.value) throw new Error("connection reset");
  },
}));

const { action } = await import("../app/routes/language");

const post = (body?: BodyInit, headers?: HeadersInit) =>
  action({ request: new Request("https://app.example/language", { method: "POST", body, headers }), params: {}, context: {} } as never);

describe("/language action", () => {
  it("returns 400 for a body it cannot read, not a 500", async () => {
    for (const headers of [undefined, { "Content-Type": "application/json" }]) {
      const response = await post(JSON.stringify({ language: "de" }), headers);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, error: "malformed" });
    }
  });

  it("returns 400 for an unsupported language", async () => {
    const response = await post("language=klingon", { "Content-Type": "application/x-www-form-urlencoded" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "unsupported" });
  });

  it("rejects prototype keys as unsupported instead of persisting them", async () => {
    for (const key of ["constructor", "toString", "__proto__"]) {
      const response = await post(`language=${key}`, { "Content-Type": "application/x-www-form-urlencoded" });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, error: "unsupported" });
    }
  });

  it("reports a failed write as ok:false at 200, so the UI can stay usable", async () => {
    failWrite.value = true;
    const response = await post("language=de", { "Content-Type": "application/x-www-form-urlencoded" });
    failWrite.value = false;

    // Not 500: a thrown action would blow away the whole app with an
    // ErrorBoundary instead of showing an inline, retryable message.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "save-failed" });
  });

  it("saves a supported language and an explicit clear", async () => {
    const ok = await post("language=de", { "Content-Type": "application/x-www-form-urlencoded" });
    await expect(ok.json()).resolves.toMatchObject({ ok: true, language: "de" });

    // No `language` field at all is also a clear, not an error.
    const cleared = await post("other=1", { "Content-Type": "application/x-www-form-urlencoded" });
    await expect(cleared.json()).resolves.toMatchObject({ ok: true, language: null });
  });
});