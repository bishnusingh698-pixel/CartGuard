/**
 * Ready-made rule sets for the block rules editor. Applying one only changes
 * the form, so the merchant reviews it (and can try it) before saving.
 * Pure, so the tests use the same logic as the page.
 */

import { newLimit, type EditorState, type LimitRow } from "./rule-editor";
import type { RuleSection } from "./rule-summary";

export const RULE_TEMPLATES = ["undeliverable", "resellers", "minimumOrder", "throwawayEmails"] as const;
export type RuleTemplate = (typeof RULE_TEMPLATES)[number];

/** The section a template fills in, so the page can scroll to it. */
export const TEMPLATE_SECTION: Record<RuleTemplate, RuleSection> = {
  undeliverable: "address",
  resellers: "quantity",
  minimumOrder: "quantity",
  throwawayEmails: "email",
};

/** Units allowed per product by the "Stop resellers" template. */
export const RESELLER_MAX_UNITS = "5";
/** Smallest order, in the shop currency, set by the "Minimum order" template. */
export const MINIMUM_ORDER_AMOUNT = "25";

const everyProductRow = (state: EditorState): LimitRow | undefined => state.limits.find((row) => row.target === "all");

/** True when the template's rules are already in the form and switched on. */
export function templateApplied(state: EditorState, template: RuleTemplate): boolean {
  switch (template) {
    case "undeliverable":
      return state.settings.enable_po_box && state.checks.po_box && state.checks.military;
    case "resellers":
      return state.settings.enable_quantity && Boolean(everyProductRow(state)?.max.trim());
    case "minimumOrder":
      return state.settings.enable_quantity && Boolean(everyProductRow(state)?.minAmount.trim());
    case "throwawayEmails":
      return state.settings.enable_email && state.blockDisposable;
  }
}

/**
 * Sets one bound on the "Every product" row, adding the row when there is
 * none. A value the merchant already typed is never overwritten.
 */
function withEveryProduct(state: EditorState, field: "max" | "minAmount", value: string): LimitRow[] {
  const existing = everyProductRow(state);
  if (!existing) return [...state.limits, { ...newLimit(), target: "all", [field]: value }];
  return state.limits.map((row) => (row === existing && !row[field].trim() ? { ...row, [field]: value } : row));
}

export function applyTemplate(state: EditorState, template: RuleTemplate): EditorState {
  switch (template) {
    case "undeliverable":
      return {
        ...state,
        settings: { ...state.settings, enable_po_box: true },
        checks: { ...state.checks, po_box: true, military: true },
      };
    case "resellers":
      return {
        ...state,
        settings: { ...state.settings, enable_quantity: true },
        limits: withEveryProduct(state, "max", RESELLER_MAX_UNITS),
      };
    case "minimumOrder":
      return {
        ...state,
        settings: { ...state.settings, enable_quantity: true },
        limits: withEveryProduct(state, "minAmount", MINIMUM_ORDER_AMOUNT),
      };
    case "throwawayEmails":
      return { ...state, settings: { ...state.settings, enable_email: true }, blockDisposable: true };
  }
}
