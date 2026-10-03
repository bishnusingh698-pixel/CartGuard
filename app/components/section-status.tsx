/**
 * Status for a block rules section, used everywhere a section is shown so the
 * same state always looks and reads the same.
 */

import { Badge } from "@shopify/polaris";
import { useI18n } from "../i18n/context";
import type { SectionSummary } from "../lib/rule-summary";

export function SectionBadge({ summary }: { summary: SectionSummary }) {
  const { t } = useI18n();
  if (!summary.enabled) return <Badge>{t("status.badge.off")}</Badge>;
  if (summary.empty) return <Badge tone="attention">{t("status.badge.empty")}</Badge>;
  return <Badge tone="success">{t("status.badge.active")}</Badge>;
}

export function useSectionStatusText(summary: SectionSummary): string {
  const { t } = useI18n();
  if (!summary.enabled) return t("status.text.off");
  if (summary.empty) return t("status.text.empty");
  return summary.details.join(" · ");
}
