/**
 * Manages CartGuard's checkout rule (a Shopify Validation that runs the
 * cartguard-validator Function), so merchants don't have to switch it on by
 * hand and so the Function receives its input query variables.
 *
 * `shopifyFunctions` lists the functions of every installed app, so
 * candidates are filtered by this app's client ID (appKey). CartGuard never
 * creates or edits a validation for another app's function.
 */

import { type AdminApi, AdminApiError, adminGraphql, errorMessage } from "./admin-api.server";

const FUNCTION_HANDLE = "cartguard-validator";
const FUNCTION_TITLE = "CartGuard Validator";

export type ValidationStatus = {
  state: "active" | "inactive" | "missing" | "function_not_deployed" | "unknown";
  message?: string;
};

const STATE_QUERY = `#graphql
  query CartGuardValidationState {
    shopifyFunctions(first: 50) {
      nodes { id title apiType appKey }
    }
    validations(first: 25) {
      nodes { id enabled blockOnFailure shopifyFunction { id } }
    }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation CartGuardValidationCreate($validation: ValidationCreateInput!) {
    validationCreate(validation: $validation) {
      validation { id }
      userErrors { field message }
    }
  }
`;

const UPDATE_MUTATION = `#graphql
  mutation CartGuardValidationUpdate($id: ID!, $validation: ValidationUpdateInput!) {
    validationUpdate(id: $id, validation: $validation) {
      validation { id enabled blockOnFailure }
      userErrors { field message }
    }
  }
`;

type FunctionNode = { id: string; title?: string | null; apiType?: string | null; appKey?: string | null };
type ValidationNode = {
  id: string;
  enabled?: boolean | null;
  blockOnFailure?: boolean | null;
  shopifyFunction?: { id?: string | null } | null;
};
type UserErrors = Array<{ field?: string[] | null; message: string }> | null | undefined;

function assertNoUserErrors(userErrors: UserErrors): void {
  if (userErrors && userErrors.length > 0) {
    throw new AdminApiError(userErrors.map((error) => error.message).join("; "));
  }
}

function isOwnValidationFunction(fn: FunctionNode, appKey: string | undefined): boolean {
  if (!(fn.apiType ?? "").toLowerCase().includes("validation")) return false;
  // Without our own client ID, only accept the exact title (never "any" function).
  return appKey ? fn.appKey === appKey : fn.title === FUNCTION_TITLE;
}

async function loadState(admin: AdminApi): Promise<{ fn: FunctionNode | null; validation: ValidationNode | null }> {
  const { data } = await adminGraphql<{
    shopifyFunctions?: { nodes?: FunctionNode[] } | null;
    validations?: { nodes?: ValidationNode[] } | null;
  }>(admin, STATE_QUERY);
  const appKey = process.env.SHOPIFY_API_KEY?.trim() || undefined;
  const candidates = (data.shopifyFunctions?.nodes ?? []).filter((fn) => isOwnValidationFunction(fn, appKey));
  const fn = candidates.find((f) => f.title === FUNCTION_TITLE) ?? candidates[0] ?? null;
  const validation = fn
    ? (data.validations?.nodes ?? []).find((v) => v.shopifyFunction?.id === fn.id) ?? null
    : null;
  return { fn, validation };
}

export async function getValidationStatus(admin: AdminApi): Promise<ValidationStatus> {
  try {
    const { fn, validation } = await loadState(admin);
    if (!fn) return { state: "function_not_deployed" };
    if (!validation) return { state: "missing" };
    return { state: validation.enabled ? "active" : "inactive" };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { state: "unknown", message: errorMessage(error) };
  }
}

async function createValidation(admin: AdminApi, functionId: string): Promise<string> {
  const base = { title: FUNCTION_TITLE, enable: true, blockOnFailure: false };
  // functionId works on current API versions; functionHandle is the newer
  // alternative. Try both so an API change can't silently break activation.
  const attempts: Array<Record<string, unknown>> = [
    { ...base, functionId },
    { ...base, functionHandle: FUNCTION_HANDLE },
  ];
  let firstError: unknown = null;
  for (const validation of attempts) {
    try {
      const { data } = await adminGraphql<{
        validationCreate?: { validation?: { id?: string | null } | null; userErrors?: UserErrors } | null;
      }>(admin, CREATE_MUTATION, { validation });
      assertNoUserErrors(data.validationCreate?.userErrors);
      const id = data.validationCreate?.validation?.id;
      if (id) return id;
      throw new AdminApiError("Shopify didn't return the new checkout rule.");
    } catch (error) {
      if (error instanceof Response) throw error;
      firstError ??= error;
    }
  }
  throw firstError instanceof Error ? firstError : new Error(errorMessage(firstError));
}

/**
 * Returns the Validation id, creating or enabling it when needed. Also forces
 * blockOnFailure off so a Function error can never block checkout.
 */
export async function ensureValidationEnabled(admin: AdminApi): Promise<string> {
  const { fn, validation } = await loadState(admin);
  if (!fn) {
    throw new Error("The CartGuard Validator function isn't deployed yet. Run `shopify app deploy`, then save again.");
  }
  if (!validation) return createValidation(admin, fn.id);
  if (!validation.enabled || validation.blockOnFailure === true) {
    const { data } = await adminGraphql<{ validationUpdate?: { userErrors?: UserErrors } | null }>(
      admin,
      UPDATE_MUTATION,
      { id: validation.id, validation: { enable: true, blockOnFailure: false } },
    );
    assertNoUserErrors(data.validationUpdate?.userErrors);
  }
  return validation.id;
}
