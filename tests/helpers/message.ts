/**
 * Renders validation messages for assertions. Violations and validation results
 * carry catalog keys rather than finished English, so a test that cares about
 * wording has to render it the way the UI does.
 */

import { DEFAULT_LANGUAGE, type Language } from "../../app/i18n/locales";
import type { ValidationMessage } from "../../app/lib/rule-summary";
import { resolveMessage } from "../../app/lib/message";

export function messageText(message: ValidationMessage, language: Language = DEFAULT_LANGUAGE): string {
  return resolveMessage(language, message);
}

/** The English text of a violation's merchant-facing explanation. */
export function detailText(detail: ValidationMessage): string {
  return resolveMessage(DEFAULT_LANGUAGE, detail);
}
