import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

/** Brand experience: mobile responsiveness, favicon, and broken-image placeholders. */
export const extractBrandExperience: EvidenceExtractor = (_scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];

  items.push({
    url: page.requestedUrl,
    category: "brand_experience",
    source: "mobile_viewport",
    severity: page.hasViewport ? "info" : "moderate",
    finding: page.hasViewport
      ? "Page declares a responsive viewport meta tag."
      : "No responsive viewport meta tag was found.",
    rawData: { present: page.hasViewport },
    confidence: 1,
    recommendationText: page.hasViewport
      ? null
      : "Add a viewport meta tag so the page renders correctly on mobile devices.",
  });

  items.push({
    url: page.requestedUrl,
    category: "brand_experience",
    source: "favicon",
    severity: page.hasFavicon ? "info" : "minor",
    finding: page.hasFavicon ? "Page declares a favicon." : "No favicon link tag was found.",
    rawData: { present: page.hasFavicon },
    confidence: 1,
    recommendationText: page.hasFavicon ? null : "Add a favicon for brand consistency in browser tabs.",
  });

  const brokenPlaceholders = page.images.filter((img) => !img.src || img.src.trim() === "").length;
  items.push({
    url: page.requestedUrl,
    category: "brand_experience",
    source: "broken_image_placeholders",
    severity: brokenPlaceholders > 0 ? "moderate" : "info",
    finding:
      brokenPlaceholders > 0
        ? `${brokenPlaceholders} image(s) have no resolvable src.`
        : "All images on this page have a resolvable src.",
    rawData: { brokenPlaceholders, totalImages: page.images.length },
    // A missing-src heuristic, not a real HTTP check of every image URL.
    confidence: 0.8,
    recommendationText:
      brokenPlaceholders > 0 ? "Fix or remove image tags that don't resolve to a real asset." : null,
  });

  return items;
};
