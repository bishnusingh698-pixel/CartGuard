/**
 * CartGuard Validator: Shopify Function entrypoint.
 *
 * Target : cart.validations.generate.run (API 2026-07)
 * Export : `run` (pinned by [[extensions.targeting]].export)
 * Input  : src/run.graphql. Rules come from app-owned shop metafields
 *          ($app:cartguard). The list of tags used by quantity limits comes
 *          from the validation's `function-configuration` metafield through
 *          input query variables ($limitTags -> product.hasTags).
 *
 * All rule logic lives in src/rules.ts, which the admin Impact Checker also
 * uses, so checkout and the simulator can never drift apart.
 *
 * Fail-open: any unexpected error returns zero validation errors, so CartGuard
 * can never break checkout. The validation is also created with
 * blockOnFailure = false.
 *
 * Rules run on every buyer journey step. Address rules can only match once a
 * delivery address exists, so on the cart step they are effectively skipped.
 */

import { evaluateCart, parseConfig, type CartAddress, type CartInput, type CartLineInput } from "./rules";
import type { FunctionError, FunctionResult } from "./function-result";

/** Hard cap so a misbehaving config cannot flood the checkout UI. */
const MAX_VALIDATION_ERRORS = 10;

type MetafieldValue = { value?: string | null } | null | undefined;

/**
 * Structural view of the input declared in src/run.graphql. Kept loose on
 * purpose so the Function doesn't depend on generated types at runtime.
 */
export type RunInput = {
  cart?: {
    /** customer is only present when the buyer is signed in to their account. */
    buyerIdentity?: { email?: string | null; customer?: { email?: string | null } | null } | null;
    lines?: Array<{
      quantity?: number | null;
      cost?: { amountPerQuantity?: { amount?: string | null } | null } | null;
      merchandise?: {
        __typename?: string;
        product?: {
          id?: string | null;
          hasTags?: Array<{ tag?: string | null; hasTag?: boolean | null } | null> | null;
        } | null;
      } | null;
    } | null> | null;
    deliveryGroups?: Array<{ deliveryAddress?: CartAddress | null } | null> | null;
    cost?: { totalAmount?: { amount?: string | null; currencyCode?: string | null } | null } | null;
  } | null;
  shop?: {
    settings?: MetafieldValue;
    regex_rules?: MetafieldValue;
    quantity_limits?: MetafieldValue;
    geo_blocklist?: MetafieldValue;
    vip_allowlist?: MetafieldValue;
  } | null;
};

/** Money arrives as a decimal string ("12.99"); anything else is unknown. */
function parseAmount(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toCartInput(input: RunInput): CartInput {
  const cart = input.cart;

  const lines: CartLineInput[] = [];
  const rawLines = Array.isArray(cart?.lines) ? cart.lines : [];
  rawLines.forEach((line, index) => {
    const merchandise = line?.merchandise;
    if (!merchandise) return;
    if (merchandise.__typename && merchandise.__typename !== "ProductVariant") return;
    const productId = merchandise.product?.id;
    if (!productId) return;
    const tags: string[] = [];
    const hasTags = Array.isArray(merchandise.product?.hasTags) ? merchandise.product.hasTags : [];
    for (const entry of hasTags) {
      if (entry?.hasTag === true && typeof entry.tag === "string") tags.push(entry.tag);
    }
    lines.push({
      index,
      productId,
      quantity: Number(line?.quantity ?? 0),
      tags,
      unitPrice: parseAmount(line?.cost?.amountPerQuantity?.amount),
    });
  });

  const addresses: CartInput["addresses"] = [];
  const groups = Array.isArray(cart?.deliveryGroups) ? cart.deliveryGroups : [];
  groups.forEach((group, groupIndex) => {
    if (group?.deliveryAddress) addresses.push({ groupIndex, address: group.deliveryAddress });
  });

  const totalAmount = cart?.cost?.totalAmount;
  return {
    email: cart?.buyerIdentity?.email ?? null,
    customerEmail: cart?.buyerIdentity?.customer?.email ?? null,
    lines,
    addresses,
    totalAmount: parseAmount(totalAmount?.amount),
    currencyCode: totalAmount?.currencyCode ?? null,
  };
}

function toResult(errors: FunctionError[]): FunctionResult {
  const seen = new Set<string>();
  const unique: FunctionError[] = [];
  for (const error of errors) {
    const key = `${error.target}|${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(error);
    if (unique.length >= MAX_VALIDATION_ERRORS) break;
  }
  return { operations: [{ validationAdd: { errors: unique } }] };
}

export function run(input: RunInput): FunctionResult {
  try {
    const shop = input?.shop ?? {};
    const config = parseConfig({
      settings: shop.settings?.value,
      regex_rules: shop.regex_rules?.value,
      quantity_limits: shop.quantity_limits?.value,
      geo_blocklist: shop.geo_blocklist?.value,
      vip_allowlist: shop.vip_allowlist?.value,
    });
    const violations = evaluateCart(toCartInput(input ?? {}), config);
    return toResult(violations.map(({ message, target }) => ({ message, target })));
  } catch {
    return toResult([]);
  }
}

export default run;
