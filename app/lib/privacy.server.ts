/**
 * GDPR helpers. The only customer personal data CartGuard handles is what a
 * merchant types into the VIP allowlist (emails and street addresses), which
 * is stored in the merchant's own shop metafields.
 */

import { type AdminApi, adminGraphql, errorMessage, setMetafields } from "./admin-api.server";
import {
  CARTGUARD_NAMESPACE,
  LEGACY_METAFIELD_TYPE,
  LEGACY_NAMESPACE,
  METAFIELD_TYPE,
  readConfiguration,
} from "./cartguard.server";
import { normalizeText, parseVipAllowlist } from "../../extensions/cartguard-validator/src/rules";

export type CustomerPrivacyPayload = {
  customer?: { id?: number | string | null; email?: string | null } | null;
  orders_to_redact?: Array<number | string> | null;
  orders_requested?: Array<number | string> | null;
};

const ORDER_ADDRESSES_QUERY = `#graphql
  query CartGuardOrderAddresses($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        shippingAddress { address1 }
        billingAddress { address1 }
      }
    }
  }
`;

async function customerIdentifiers(
  admin: AdminApi,
  payload: CustomerPrivacyPayload,
  orderIds: Array<number | string> | null | undefined,
): Promise<Set<string>> {
  const identifiers = new Set<string>();
  const email = normalizeText(payload.customer?.email);
  if (email) identifiers.add(email);

  const ids = (orderIds ?? [])
    .map(String)
    .filter((id) => /^\d+$/.test(id))
    .slice(0, 50)
    .map((id) => `gid://shopify/Order/${id}`);
  if (ids.length > 0) {
    try {
      const { data } = await adminGraphql<{
        nodes?: Array<{ shippingAddress?: { address1?: string | null } | null; billingAddress?: { address1?: string | null } | null } | null>;
      }>(admin, ORDER_ADDRESSES_QUERY, { ids });
      for (const node of data.nodes ?? []) {
        for (const address1 of [node?.shippingAddress?.address1, node?.billingAddress?.address1]) {
          const normalized = normalizeText(address1);
          if (normalized) identifiers.add(normalized);
        }
      }
    } catch (error) {
      if (error instanceof Response) throw error;
      console.warn("[GDPR] Could not load order addresses, matching by email only:", errorMessage(error));
    }
  }
  return identifiers;
}

/** Number of VIP allowlist entries that match the customer. */
export async function findCustomerInAllowlist(admin: AdminApi, payload: CustomerPrivacyPayload): Promise<number> {
  const identifiers = await customerIdentifiers(admin, payload, payload.orders_requested);
  if (identifiers.size === 0) return 0;
  const stored = await readConfiguration(admin);
  let matches = 0;
  for (const raw of [stored.current, stored.legacy]) {
    if (!raw?.vip_allowlist) continue;
    matches += parseVipAllowlist(raw.vip_allowlist).filter((entry) => identifiers.has(normalizeText(entry))).length;
  }
  return matches;
}

/** Removes the customer's email/addresses from the VIP allowlist. Returns the number removed. */
export async function redactCustomerFromAllowlist(admin: AdminApi, payload: CustomerPrivacyPayload): Promise<number> {
  const identifiers = await customerIdentifiers(admin, payload, payload.orders_to_redact);
  if (identifiers.size === 0) return 0;
  const stored = await readConfiguration(admin);

  const targets = [
    { raw: stored.current, namespace: CARTGUARD_NAMESPACE, type: METAFIELD_TYPE },
    { raw: stored.legacy, namespace: LEGACY_NAMESPACE, type: LEGACY_METAFIELD_TYPE },
  ];

  let removed = 0;
  for (const target of targets) {
    if (!target.raw?.vip_allowlist) continue;
    const list = parseVipAllowlist(target.raw.vip_allowlist);
    const kept = list.filter((entry) => !identifiers.has(normalizeText(entry)));
    if (kept.length === list.length) continue;
    removed += list.length - kept.length;
    await setMetafields(admin, [
      { ownerId: stored.shopId, namespace: target.namespace, key: "vip_allowlist", type: target.type, value: JSON.stringify(kept) },
    ]);
  }
  return removed;
}
