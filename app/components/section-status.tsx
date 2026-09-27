/**
 * Status for a block rules section, used everywhere a section is shown so the
 * same state always looks and reads the same.
 */

import { Badge } from "@shopify/polaris";
import type { SectionSummary } from "../lib/rule-summary";

export function SectionBadge({ summary }: { summary: SectionSummary }) {
  if (!summary.enabled) return <Badge>Off</Badge>;
  if (summary.empty) return <Badge tone="attention">Nothing added yet</Badge>;
  return <Badge tone="success">Active</Badge>;
}

export function sectionStatusText(summary: SectionSummary): string {
  if (!summary.enabled) return "Off. Orders aren't checked for this.";
  if (summary.empty) return "On, but nothing is added yet, so nothing is blocked.";
  return summary.details.join(" · ");
}
