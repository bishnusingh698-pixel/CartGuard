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
