import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

/** Analytics: whether a recognizable analytics/tag-manager snippet is present. */
export const extractAnalytics: EvidenceExtractor = (_scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];
  items.push({
    url: page.requestedUrl,
    category: "analytics",
    source: "analytics_tag",
    severity: page.hasAnalyticsTag ? "info" : "moderate",
    finding: page.hasAnalyticsTag
      ? "A recognizable analytics/tag-manager snippet was detected."
      : "No recognizable analytics or tag-manager snippet was detected.",
    rawData: { present: page.hasAnalyticsTag },
    // Pattern-matched against known tags (GA4/GTM/UA) — a bespoke or unrecognized analytics
    // tool would not be caught, hence < 1.0.
    confidence: 0.85,
    recommendationText: page.hasAnalyticsTag
      ? null
      : "Install GA4 or a tag manager so traffic and conversions can be measured.",
  });

  return items;
};
