/**
 * Thin, strict wrapper around the Admin GraphQL client.
 *
 * - Thrown `Response` objects (re-auth / bounce) are always re-thrown so the
 *   Shopify library can handle them.
 * - GraphQL errors and userErrors become AdminApiError with a readable message.
 */

export type AdminApi = {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response>;
};

export type GraphqlCost = {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: {
    maximumAvailable?: number;
    currentlyAvailable?: number;
    restoreRate?: number;
  };
};

export class AdminApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminApiError";
  }
}

function formatGraphqlErrors(errors: unknown): string {
  if (Array.isArray(errors)) {
    return errors
      .map((entry) => (entry && typeof entry === "object" && "message" in entry ? String((entry as { message: unknown }).message) : JSON.stringify(entry)))
      .join("; ");
  }
  if (errors && typeof errors === "object") {
    if ("graphQLErrors" in errors) return formatGraphqlErrors((errors as { graphQLErrors: unknown }).graphQLErrors);
    if ("message" in errors) return String((errors as { message: unknown }).message);
  }
  return typeof errors === "string" ? errors : JSON.stringify(errors);
}

export function errorMessage(error: unknown): string {
  const body = (error as { body?: { errors?: unknown } } | null)?.body;
  if (body?.errors) return formatGraphqlErrors(body.errors);
  if (error instanceof Error) return error.message;
  return String(error);
}

/** An error whose message was written for merchants and can be shown as-is. */
export class MerchantFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MerchantFacingError";
  }
}

/**
 * Merchant-facing wording for a failure. Raw GraphQL / network details belong
 * in the server log (use errorMessage), never in the admin UI.
 */
export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof MerchantFacingError) return error.message;
  const detail = errorMessage(error).toLowerCase();
  if (/throttl|rate limit|\b429\b/.test(detail)) {
    return "Shopify is handling a lot of requests from your store right now. Wait a minute and try again.";
  }
  if (/not approved to access|protected customer data/.test(detail)) {
    return "CartGuard hasn't been approved by Shopify to read order details yet, so it can't test your rules on past orders. Your rules still work at checkout.";
  }
  if (/max cost limit|exceeds the single query/.test(detail)) {
    return "Your recent orders were too large to check in one go. Try again in a moment. If it keeps happening, contact support@cartguard.io.";
  }
  if (/access denied|access scope|\b401\b|\b403\b/.test(detail)) {
    return "CartGuard doesn't have the permission it needs. Open CartGuard from your Shopify admin, approve any requested permissions, then try again.";
  }
  if (/timeout|timed out|econnreset|fetch failed|socket|\b50[234]\b/.test(detail)) {
    return "Shopify didn't respond in time. Check your connection and try again in a moment.";
  }
  return "Something went wrong while talking to Shopify. Try again in a moment. If it keeps happening, contact support@cartguard.io.";
}

export async function adminGraphql<T>(
  admin: AdminApi,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T; cost?: GraphqlCost }> {
  let response: Response;
  try {
    response = await admin.graphql(query, variables ? { variables } : undefined);
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new AdminApiError(errorMessage(error));
  }

  let body: { data?: T; errors?: unknown; extensions?: { cost?: GraphqlCost } };
  try {
    body = await response.json();
  } catch {
    throw new AdminApiError(`Shopify returned an unreadable response (HTTP ${response.status}).`);
  }
  if (body.errors) throw new AdminApiError(formatGraphqlErrors(body.errors));
  if (!body.data) throw new AdminApiError("Shopify returned an empty response.");
  return { data: body.data, cost: body.extensions?.cost };
}

export type MetafieldWrite = {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
};

const METAFIELDS_SET_MUTATION = `#graphql
  mutation CartGuardMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key }
      userErrors { field message }
    }
  }
`;

export async function setMetafields(admin: AdminApi, metafields: MetafieldWrite[]): Promise<void> {
  if (metafields.length === 0) return;
  const { data } = await adminGraphql<{
    metafieldsSet?: { userErrors?: Array<{ field?: string[] | null; message: string }> | null } | null;
  }>(admin, METAFIELDS_SET_MUTATION, { metafields });
  const userErrors = data.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new AdminApiError(userErrors.map((error) => error.message).join("; "));
  }
}
