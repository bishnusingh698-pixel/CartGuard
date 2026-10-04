/**
 * Quantity and order-value limits, including the min/max bounds the merchant
 * sets in the editor. Covers both sides of every boundary.
 */

import { describe, expect, it } from "vitest";
import { detailText } from "./helpers/message";
import {
  amountBounds,
  cartTotal,
  evaluateCart,
  type CartInput,
  type QuantityLimit,
  type RuleConfig,
} from "../extensions/cartguard-validator/src/rules";

const ALL_ON = { enable_vip: true, enable_po_box: true, enable_quantity: true, enable_geo: true };
const PID = "gid://shopify/Product/1";

function config(limits: Record<string, QuantityLimit>): RuleConfig {
  return {
    settings: { ...ALL_ON },
    regexRules: [],
    quantityLimits: limits,
    geoBlocklist: { countries: [], zips: [], cities: [], states: [] },
    vipAllowlist: [],
  };
}

function cart(quantity: number, extra: Partial<CartInput> = {}): CartInput {
  return {
    email: null,
    lines: [{ index: 0, productId: PID, quantity, tags: [], unitPrice: 10 }],
    addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }],
    ...extra,
  };
}

const quantityViolations = (quantity: number, limits: Record<string, QuantityLimit>) =>
  evaluateCart(cart(quantity), config(limits)).filter((v) => v.rule === "quantity");

describe("maximum quantity", () => {
  it("allows up to and including the limit", () => {
    for (const quantity of [1, 4, 5]) {
      expect(quantityViolations(quantity, { all: { max: 5 } }), String(quantity)).toHaveLength(0);
    }
  });

  it("blocks above the limit", () => {
    for (const quantity of [6, 7, 100]) {
      const v = quantityViolations(quantity, { all: { max: 5 } });
      expect(v, String(quantity)).toHaveLength(1);
      expect(detailText(v[0].detail)).toMatch(/exceed the limit of 5/);
    }
  });

  it("sums the same product across variants before comparing", () => {
    // 3 + 3 = 6 units of one product, which exceeds a limit of 5 even though
    // neither line does on its own.
    const split: CartInput = {
      email: null,
      lines: [
        { index: 0, productId: PID, quantity: 3, tags: [], unitPrice: 10 },
        { index: 1, productId: PID, quantity: 3, tags: [], unitPrice: 10 },
      ],
      addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }],
    };
    expect(evaluateCart(split, config({ all: { max: 5 } })).filter((v) => v.rule === "quantity")).toHaveLength(1);
  });

  it("blames the first line of the product", () => {
    const v = quantityViolations(9, { all: { max: 1 } });
    expect(v[0].target).toBe("$.cart.lines[0].quantity");
  });
});

describe("minimum quantity", () => {
  it("allows at or above the minimum", () => {
    for (const quantity of [3, 4, 10]) {
      expect(quantityViolations(quantity, { all: { min: 3 } }), String(quantity)).toHaveLength(0);
    }
  });

  it("blocks below the minimum", () => {
    for (const quantity of [1, 2]) {
      const v = quantityViolations(quantity, { all: { min: 3 } });
      expect(v, String(quantity)).toHaveLength(1);
      expect(detailText(v[0].detail)).toMatch(/below the minimum of 3/);
    }
  });

  it("enforces the minimum the same way for the whole order and a tag", () => {
    expect(quantityViolations(1, { all: { min: 3 } })).toHaveLength(1);
    expect(quantityViolations(1, { "gift": { min: 3 } })).toHaveLength(0);
  });

  it("combines min and max on one product", () => {
    const limits = { all: { min: 2, max: 5 } };
    expect(quantityViolations(1, limits)).toHaveLength(1);
    expect(quantityViolations(3, limits)).toHaveLength(0);
    expect(quantityViolations(9, limits)).toHaveLength(1);
  });
});

describe("limit scoping", () => {
  it("applies a tag limit only to lines carrying that tag", () => {
    const tagged: CartInput = {
      email: null,
      lines: [{ index: 0, productId: PID, quantity: 9, tags: ["fragile"], unitPrice: 10 }],
      addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }],
    };
    expect(evaluateCart(tagged, config({ fragile: { max: 2 } })).filter((v) => v.rule === "quantity")).toHaveLength(1);

    const untagged: CartInput = { ...tagged, lines: [{ index: 0, productId: PID, quantity: 9, tags: [], unitPrice: 10 }] };
    expect(evaluateCart(untagged, config({ fragile: { max: 2 } })).filter((v) => v.rule === "quantity")).toHaveLength(0);
  });

  it("matches tags case-insensitively", () => {
    const tagged: CartInput = {
      email: null,
      lines: [{ index: 0, productId: PID, quantity: 9, tags: ["FRAGILE"], unitPrice: 10 }],
      addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }],
    };
    expect(evaluateCart(tagged, config({ fragile: { max: 2 } })).filter((v) => v.rule === "quantity")).toHaveLength(1);
  });

  it("lets the tightest limit win when several match", () => {
    const tagged: CartInput = {
      email: null,
      lines: [{ index: 0, productId: PID, quantity: 9, tags: ["fragile"], unitPrice: 10 }],
      addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }],
    };
    const v = evaluateCart(tagged, config({ all: { max: 100 }, fragile: { max: 2 } })).filter((x) => x.rule === "quantity");
    expect(v).toHaveLength(1);
    expect(detailText(v[0].detail)).toMatch(/limit of 2/);
  });

  it("applies a product-id limit only to that product", () => {
    const other: CartInput = {
      email: null,
      lines: [{ index: 0, productId: "gid://shopify/Product/2", quantity: 9, tags: [], unitPrice: 10 }],
      addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }],
    };
    expect(evaluateCart(other, config({ [PID]: { max: 1 } })).filter((v) => v.rule === "quantity")).toHaveLength(0);
  });

  it("ignores a limit no product in the cart matches", () => {
    expect(quantityViolations(9, { "no-such-tag": { max: 1 } })).toHaveLength(0);
  });

  it("accepts the legacy bare-number shorthand as a maximum", () => {
    expect(quantityViolations(9, { all: 5 as unknown as QuantityLimit })).toHaveLength(0);
  });
});

describe("order amount bounds", () => {
  const amount = (total: number | null, limits: Record<string, QuantityLimit>) =>
    evaluateCart(cart(1, { totalAmount: total }), config(limits)).filter((v) => v.rule === "amount");

  it("allows a total inside the range", () => {
    expect(amount(500, { all: { minAmount: 100, maxAmount: 1000 } })).toHaveLength(0);
  });

  it("blocks above the maximum", () => {
    const v = amount(1500, { all: { maxAmount: 1000 } });
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("amount");
  });

  it("blocks below the minimum", () => {
    expect(amount(50, { all: { minAmount: 100 } })).toHaveLength(1);
  });

  it("does not block when there is no trustworthy total", () => {
    // Never block a checkout on a guess about the price. A cart with no
    // explicit total and no usable line price yields no total at all, so the
    // minAmount rule stays silent rather than assuming $0.
    const priceless: CartInput = {
      email: null,
      lines: [{ index: 0, productId: PID, quantity: 2, unitPrice: null }],
      addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }],
    };
    const violations = evaluateCart(priceless, config({ all: { minAmount: 100 } })).filter((v) => v.rule === "amount");
    expect(violations).toHaveLength(0);
  });

  it("falls back to summing line prices when there is no explicit total", () => {
    // 2 units at $10 is a $20 order, which is below a $100 minimum, so the
    // rule fires on the computed figure.
    const v = evaluateCart(cart(2), config({ all: { minAmount: 100 } })).filter((x) => x.rule === "amount");
    expect(v).toHaveLength(1);
    expect(detailText(v[0].detail)).toMatch(/below the minimum/);
  });

  it("scopes an amount limit to the products it actually covers", () => {
    // A tag-scoped amount bound must not decide the fate of an unrelated order.
    expect(amount(50, { premium: { minAmount: 900 } })).toHaveLength(0);
    expect(amount(1000, { premium: { minAmount: 900 } })).toHaveLength(0);
  });

  it("keeps the tightest of several matching amount bounds", () => {
    // "sale" only counts when a line in the cart actually carries that tag.
    const tagged: CartInput = {
      email: null,
      lines: [{ index: 0, productId: PID, quantity: 1, tags: ["sale"], unitPrice: 10 }],
      addresses: [{ groupIndex: 0, address: { address1: "1 Main", countryCode: "US" } }],
    };
    const limits = { all: { minAmount: 100, maxAmount: 5_000 }, sale: { minAmount: 250 } };
    expect(amountBounds(tagged, limits)).toEqual({ min: 250, max: 5_000 });
    // Without the tag only the global row applies.
    expect(amountBounds(cart(1), limits)).toEqual({ min: 100, max: 5_000 });
  });

  it("ignores a limit with neither an amount bound nor a unit bound", () => {
    expect(amount(50, { all: { message: "hi" } as QuantityLimit })).toHaveLength(0);
  });
});

describe("cartTotal", () => {
  it("prefers the explicit total", () => {
    expect(cartTotal(cart(2, { totalAmount: 99.99 }))).toBe(99.99);
  });

  it("falls back to summing line prices", () => {
    expect(cartTotal({ email: null, lines: [{ index: 0, productId: PID, quantity: 3, unitPrice: 10.005 }], addresses: [] })).toBe(30.02);
  });

  it("returns null when nothing is knowable", () => {
    expect(cartTotal({ email: null, lines: [], addresses: [] })).toBeNull();
  });

  it("ignores a non-numeric unit price", () => {
    expect(cartTotal({ email: null, lines: [{ index: 0, productId: PID, quantity: 2, unitPrice: null }], addresses: [] })).toBeNull();
  });
});