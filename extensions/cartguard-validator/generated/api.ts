/**
 * Machine-generated types matching extensions/cartguard-validator/src/run.graphql
 * and extensions/cartguard-validator/input-schema.graphql.
 */

export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };

export type BuyerJourneyStep = "CART" | "CHECKOUT" | "CHECKOUT_COMPLETION" | "POST_CHECKOUT";

export type RunInputQuery = {
  buyerJourney: {
    step: BuyerJourneyStep;
  };
  cart: {
    buyerIdentity?: {
      email?: string | null;
    } | null;
    lines: Array<{
      quantity: number;
      merchandise:
        | {
            __typename: "ProductVariant";
            id?: string | null;
            product?: {
              id?: string | null;
            } | null;
          }
        | {
            __typename: "CustomMerchandise";
            id?: string | null;
          };
    }>;
    deliveryGroups: Array<{
      deliveryAddress?: {
        address1?: string | null;
        address2?: string | null;
        city?: string | null;
        provinceCode?: string | null;
        zip?: string | null;
        countryCode?: string | null;
      } | null;
    }>;
    billingAddress?: {
      address1?: string | null;
      city?: string | null;
      provinceCode?: string | null;
      zip?: string | null;
      countryCode?: string | null;
    } | null;
  };
  shop: {
    regex_rules?: { value?: string | null } | null;
    quantity_limits?: { value?: string | null } | null;
    geo_blocklist?: { value?: string | null } | null;
    vip_allowlist?: { value?: string | null } | null;
    settings?: { value?: string | null } | null;
  };
};
