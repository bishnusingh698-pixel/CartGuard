/**
 * Shared loading for the admin pages: Shopify auth (with the local demo
 * fallback) and the saved rules plus checkout status.
 */

import { authenticate } from "../shopify.server";
import type { AdminApi } from "./admin-api.server";
import { canUseMockAdmin, createMockAdmin } from "./admin-mock.server";
import { effectiveRaw, parseConfig, readConfiguration } from "./cartguard.server";
import { type ValidationStatus, getValidationStatus } from "./validation.server";
import type { RuleConfig } from "../../extensions/cartguard-validator/src/rules";

export type RulesState = {
  config: RuleConfig;
  validation: ValidationStatus;
  /** Rules saved by an older build that aren't applied at checkout until saved again. */
  needsMigration: boolean;
  /** Local preview with sample data, outside the Shopify admin. */
  isDemo: boolean;
};

export async function getAdmin(request: Request): Promise<{ admin: AdminApi; isDemo: boolean; shop: string | undefined }> {
  try {
    const auth = await authenticate.admin(request);
    return { admin: auth.admin, isDemo: false, shop: auth.session.shop };
  } catch (error) {
    // Demo data is only for local previews. In production an unauthenticated
    // request must go through Shopify auth, never get a fake store.
    if (error instanceof Response && canUseMockAdmin(request)) {
      return { admin: createMockAdmin(), isDemo: true, shop: undefined };
    }
    throw error;
  }
}

export async function loadRulesState(admin: AdminApi, isDemo: boolean): Promise<RulesState> {
  const [stored, validation] = await Promise.all([readConfiguration(admin), getValidationStatus(admin)]);
  return {
    config: parseConfig(effectiveRaw(stored)),
    validation,
    needsMigration: !stored.current && Boolean(stored.legacy),
    isDemo,
  };
}
