/**
 * Renders validation messages in the reader's language. Lives outside
 * cartguard.server so client components can use it too.
 */

import { formatNumber, translate, type MessageKey } from "../i18n/catalog";
import { type MessageValue, type ValidationMessage } from "./rule-summary";
import type { Language } from "../i18n/locales";

/** The placeholders whose values are other messages and so get translated first. */
const NESTED_VALUE_NAMES = new Set(["label", "field", "hint"]);

/**
 * Messages that quote another message (a label like "Every product", a field
 * name, a hint) pass it as a nested message, which is resolved first and then
 * interpolated into the outer text. Everything else is literal data, so
 * merchant-entered text such as a product tag is never mistaken for a key.
 */
export function resolveMessage(language: Language, message: ValidationMessage): string {
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(message.values ?? {})) {
    values[name] = resolveValue(language, value, NESTED_VALUE_NAMES.has(name));
  }
  return translate(language, message.key as MessageKey, values);
}

function resolveValue(language: Language, value: MessageValue, isNested: boolean): string {
  if (Array.isArray(value)) return value.map((entry) => resolveValue(language, entry, false)).join("; ");
  if (typeof value === "object") return resolveMessage(language, value);
  if (typeof value === "number") return formatNumber(language, value);
  if (!isNested) return value;
  // Declared as a nested message, so the catalog entry is the reference.
  return translate(language, value as MessageKey);
}
