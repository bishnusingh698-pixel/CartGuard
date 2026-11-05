/**
 * Output contract for the cart.validations.generate.run target.
 * Errors use `message` (not the legacy `localizedMessage`).
 */

export type FunctionError = {
  /** Buyer-facing message shown in cart/checkout. */
  message: string;
  /** JSONPath into the Function input, e.g. $.cart.deliveryGroups[0].deliveryAddress.zip */
  target: string;
};

export type FunctionResult = {
  operations: Array<{
    validationAdd: {
      errors: FunctionError[];
    };
  }>;
};
