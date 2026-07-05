import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

/** Accessibility: image alt text coverage, document language, and heading structure. */
export const extractAccessibility: EvidenceExtractor = (_scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];
  const imgTotal = page.images.length;
  const imgWithAlt = page.images.filter((img) => Boolean(img.alt && img.alt.trim())).length;
  const imagesOk = imgTotal === 0 || imgWithAlt === imgTotal;
  items.push({
    url: page.requestedUrl,
    category: "accessibility",
    source: "image_alt_text",
    severity: imagesOk ? "info" : "moderate",
    finding: `${imgWithAlt} of ${imgTotal} images on this page have alt text.`,
    rawData: { total: imgTotal, withAlt: imgWithAlt },
    confidence: 1,
    recommendationText:
      imgTotal > 0 && !imagesOk ? "Add descriptive alt text to all meaningful images." : null,
  });

  const hasLang = Boolean(page.htmlLang);
  items.push({
    url: page.requestedUrl,
    category: "accessibility",
    source: "html_lang_attribute",
    severity: hasLang ? "info" : "minor",
    finding: hasLang
      ? "The <html> tag declares a lang attribute."
      : "The <html> tag is missing a lang attribute.",
    rawData: { present: hasLang, lang: page.htmlLang },
    confidence: 1,
    recommendationText: hasLang ? null : "Add a lang attribute to the <html> tag.",
  });

  const headingOk = page.h1Count === 1;
  items.push({
    url: page.requestedUrl,
    category: "accessibility",
    source: "heading_structure",
    severity: headingOk ? "info" : "minor",
    finding: `Page has ${page.h1Count} <h1> tag(s) and ${page.h2.length} <h2> tag(s).`,
    rawData: { h1Count: page.h1Count, h2Count: page.h2.length },
    confidence: 0.9,
    recommendationText: headingOk
      ? null
      : "Use a single <h1> as the page's main landmark so screen reader users can navigate the outline reliably.",
  });

  return items;
};
