/**
 * Impact Checker and configuration-loading resilience.
 *
 * These cover the shapes that made the Impact Checker throw a raw TypeError
 * instead of reporting a usable failure, plus the throttling and permission
 * paths a real store hits.
 */

import { describe, expect, it } from "vitest";
import { readConfiguration, simulateImpact, type RuleConfig } from "../app/lib/cartguard.server";
import { AdminApiError, friendlyErrorMessage } from "../app/lib/admin-api.server";

const config = {
  settings: { enable_vip: true, enable_po_box: true, enable_quantity: true, enable_geo: true },
  regexRules: [{ pattern: "po box" }],
  quantityLimits: {},
  geoBlocklist: { countries: [], zips: [], cities: [], states: [] },
  vipAllowlist: [],
} as unknown as RuleConfig;

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Admin stub returning a fixed sequence, repeating the last entry. */
const adminReturning = (...responses: Array<() => Response>) => {
  let call = 0;
  return {
    graphql: async () => {
      const make = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return make();
    },
  };
};

describe("Impact Checker survives malformed GraphQL shapes", () => {
  it("tolerates a nodes field that is not an array", () => {
    // This threw "Spread syntax requires ...iterable[Symbol.iterator] to be a
    // function", a raw TypeError the merchant could do nothing with.
    const admin = adminReturning(
      json({ data: { orders: { nodes: { foo: 1 }, pageInfo: { hasNextPage: false, endCursor: null } } } }),
    );
    return expect(simulateImpact(admin as never, config)).resolves.toMatchObject({ scanned: 0, blocked: 0 });
  });

  it("tolerates nodes being a string, a number or a boolean", async () => {
    for (const nodes of ["nope", 7, true]) {
      const admin = adminReturning(json({ data: { orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }));
      await expect(simulateImpact(admin as never, config), JSON.stringify(nodes)).resolves.toMatchObject({ scanned: 0 });
    }
  });

  it("tolerates a missing orders connection", async () => {
    const admin = adminReturning(json({ data: {} }));
    await expect(simulateImpact(admin as never, config)).resolves.toMatchObject({ scanned: 0 });
  });

  it("tolerates pageInfo being missing or a non-object", async () => {
    for (const pageInfo of [undefined, null, "x", 5]) {
      const admin = adminReturning(json({ data: { orders: { nodes: [], pageInfo } } }));
      await expect(simulateImpact(admin as never, config), JSON.stringify(pageInfo)).resolves.toMatchObject({ scanned: 0 });
    }
  });
});

describe("Impact Checker reports platform failures clearly", () => {
  it("surfaces a GraphQL permission error as an AdminApiError", async () => {
    const admin = adminReturning(json({ errors: [{ message: "Access denied: requires read_orders scope" }] }));
    await expect(simulateImpact(admin as never, config)).rejects.toBeInstanceOf(AdminApiError);
  });

  it("does not mask a partial-data GraphQL error", async () => {
    // data present *and* errors present: ignoring errors would report "0
    // blocked" as if the rules were safe, which is the dangerous outcome.
    const admin = adminReturning(json({ data: { orders: null }, errors: [{ message: "Access denied" }] }));
    await expect(simulateImpact(admin as never, config)).rejects.toThrow(/Access denied/);
  });

  it("turns an empty or non-JSON body into a readable error", async () => {
    for (const body of ["", "not json", "<html>502</html>"]) {
      const admin = adminReturning(() => new Response(body, { status: 200 }));
      await expect(simulateImpact(admin as never, config), body).rejects.toThrow(/unreadable response/i);
    }
  });

  it("rejects a response with no data at all", async () => {
    const admin = adminReturning(json({ somethingElse: true }));
    await expect(simulateImpact(admin as never, config)).rejects.toThrow(/empty response/i);
  });

  it("keeps a network error recognisable instead of swallowing it", async () => {
    const admin = adminReturning(() => {
      throw new Error("ECONNRESET");
    });
    await expect(simulateImpact(admin as never, config)).rejects.toThrow(/ECONNRESET/);
  });
});

describe("merchant-facing wording", () => {
  it("explains throttling rather than showing a raw HTTP status", () => {
    expect(friendlyErrorMessage(new AdminApiError("Shopify returned an unreadable response (HTTP 429)."))).toMatch(/handling a lot of requests/i);
  });

  it("explains a missing scope with an actionable step", () => {
    expect(friendlyErrorMessage(new AdminApiError("Access denied"))).toMatch(/approve any requested permissions/i);
  });

  it("explains a timeout", () => {
    expect(friendlyErrorMessage(new Error("fetch failed"))).toMatch(/didn't respond in time/i);
  });

  it("never leaks raw GraphQL detail into the UI", () => {
    const raw = 'Cannot query field "foo" on type "Order". Did you mean "fooBar"?';
    expect(friendlyErrorMessage(new AdminApiError(raw))).not.toContain("fooBar");
  });

  it("passes a merchant-written message through unchanged", () => {
    expect(friendlyErrorMessage(new AdminApiError("unreadable response (HTTP 429)."))).toMatch(/handling a lot/i);
  });
});

describe("configuration loading survives malformed metafields", () => {
  it("reads a normal configuration", async () => {
    const admin = adminReturning(
      json({
        data: {
          shop: {
            id: "gid://shopify/Shop/1",
            current: { nodes: [{ key: "settings", value: '{"enable_po_box":true}' }] },
            legacy: { nodes: [] },
          },
        },
      }),
    );
    const stored = await readConfiguration(admin as never);
    expect(stored.shopId).toBe("gid://shopify/Shop/1");
    expect(stored.current?.settings).toBe('{"enable_po_box":true}');
  });

  it("tolerates a metafield connection whose nodes is not an array", async () => {
    // This ran on every admin page load, so a non-array here broke the whole app.
    const admin = adminReturning(json({ data: { shop: { id: "gid://shopify/Shop/1", current: { nodes: "oops" }, legacy: null } } }));
    const stored = await readConfiguration(admin as never);
    expect(stored.shopId).toBe("gid://shopify/Shop/1");
    expect(stored.current).toBeNull();
  });

  it("tolerates null nodes inside the connection", async () => {
    const admin = adminReturning(
      json({ data: { shop: { id: "gid://shopify/Shop/1", current: { nodes: [null, { key: "settings", value: "{}" }] }, legacy: { nodes: [] } } } }),
    );
    const stored = await readConfiguration(admin as never);
    expect(stored.current?.settings).toBe("{}");
  });

  it("fails loudly when the shop itself is missing", async () => {
    const admin = adminReturning(json({ data: { shop: null } }));
    await expect(readConfiguration(admin as never)).rejects.toThrow(/Unable to load the shop/);
  });
});