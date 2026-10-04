/**
 * Status for a block rules section, used everywhere a section is shown so the
 * same state always looks and reads the same.
 */

import { Badge } from "@shopify/polaris";
import { useI18n } from "../i18n/context";
import { formatList, formatNumber, plural, translate, type MessageKey } from "../i18n/catalog";
import type { Language } from "../i18n/locales";
import type { SectionSummary, SummaryDetail } from "../lib/rule-summary";

export function SectionBadge({ summary }: { summary: SectionSummary }) {
  const { t } = useI18n();
  if (!summary.enabled) return <Badge>{t("status.badge.off")}</Badge>;
  if (summary.empty) return <Badge tone="attention">{t("status.badge.empty")}</Badge>;
  return <Badge tone="success">{t("status.badge.active")}</Badge>;
}

/**
 * Renders one summary detail. Details carry a message key and a count rather
 * than a finished sentence, so the count can be pluralised and the text
 * translated in the reader's language.
 */
function detailText(detail: SummaryDetail, language: Language): string {
  const t = (key: MessageKey, values?: Record<string, string | number>) => translate(language, key, values);
  if (detail.values) {
    const names = formatList(language, detail.values);
    return detail.more === undefined ? names : t("summary.moreWith", { names, count: formatNumber(language, detail.more) });
  }
  if (detail.count === undefined) return t(detail.key);
  return plural(language, { one: t(`${detail.key}.one` as MessageKey), other: t(`${detail.key}.other` as MessageKey) }, detail.count);
}

export function useSectionStatusText(summary: SectionSummary): string {
  const { language, t } = useI18n();
  if (!summary.enabled) return t("status.text.off");
  if (summary.empty) return t("status.text.empty");
  return summary.details.map((detail) => detailText(detail, language)).join(" · ");
}
