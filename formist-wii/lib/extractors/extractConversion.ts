import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

/** Conversion: contact affordances (forms, mailto/tel links) and CTA presence. */
export const extractConversion: EvidenceExtractor = (_scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];
  const hasContact = page.forms.length > 0 || page.contactLinks.length > 0;
  items.push({
    url: page.requestedUrl,
    category: "conversion",
    source: "contact_affordance",
    severity: hasContact ? "info" : "minor",
    finding: hasContact
      ? "Page includes a form, mailto:, or tel: contact affordance."
      : "No form, mailto:, or tel: contact affordance found on this page.",
    rawData: { forms: page.forms.length, contactLinks: page.contactLinks.length },
    confidence: 1,
    recommendationText: hasContact
      ? null
      : "Add a clear call-to-action or contact method on this page.",
  });

  const hasCta = page.buttons.length > 0;
  items.push({
    url: page.requestedUrl,
    category: "conversion",
    source: "cta_presence",
    severity: hasCta ? "info" : "minor",
    finding: hasCta
      ? `Page has ${page.buttons.length} button(s)/CTA(s): ${page.buttons.slice(0, 3).join(", ")}${page.buttons.length > 3 ? ", …" : ""}`
      : "No buttons or call-to-action elements were found on this page.",
    rawData: { count: page.buttons.length, samples: page.buttons.slice(0, 5) },
    confidence: 1,
    recommendationText: hasCta
      ? null
      : "Add a clear call-to-action button so visitors know what to do next.",
  });

  return items;
};
