import type { CrawledPageData } from "@/lib/crawler-service";
import type { EvidenceExtractor, NormalizedEvidence, ScanContext } from "./types";
import { isCrawlOk, isHomepage } from "./types";

const TRUST_IMAGE_ALT_PATTERN = /logo|award|badge|certifi|accredit/i;
const TITLE_SEPARATOR_PATTERN = /\s*[|\-–·]\s*/;

/**
 * Brand experience: positioning clarity, brand-language consistency, trust/differentiation/proof
 * signals, visual-presentation proxies, audience specificity, and (where present) ESG and
 * human-centered-design language. Evidence only — no scoring here (see lib/scoring.ts).
 *
 * These are qualitative, brand-strategy dimensions, so several checks are necessarily heuristic
 * proxies built from deterministic page signals (text patterns, headings, metadata, whether a
 * screenshot was captured) rather than genuine visual/brand judgment — confidence is reduced
 * throughout to reflect that, and findings are worded as observations, not verdicts.
 */
export const extractBrandExperience: EvidenceExtractor = (scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [
    checkMobileViewport(page),
    checkFavicon(page),
    checkBrokenImagePlaceholders(page),
    checkScreenshotCaptured(page),
    checkClarityOfPositioning(page),
    checkTrustSignals(page),
    checkDifferentiationLanguage(page),
    checkProofPoints(page),
    checkAudienceSpecificity(page),
    checkEsgSignals(page),
    checkHumanCenteredSignals(page),
  ];

  if (isHomepage(scan, page)) {
    items.push(checkBrandLanguageConsistency(scan, page));
  }

  return items;
};

function checkMobileViewport(page: CrawledPageData): NormalizedEvidence {
  return {
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
  };
}

function checkFavicon(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "brand_experience",
    source: "favicon",
    severity: page.hasFavicon ? "info" : "minor",
    finding: page.hasFavicon ? "Page declares a favicon." : "No favicon link tag was found.",
    rawData: { present: page.hasFavicon },
    confidence: 1,
    recommendationText: page.hasFavicon ? null : "Add a favicon for brand consistency in browser tabs.",
  };
}

function checkBrokenImagePlaceholders(page: CrawledPageData): NormalizedEvidence {
  const brokenPlaceholders = page.images.filter((img) => !img.src || img.src.trim() === "").length;
  return {
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
  };
}

/**
 * Whether a screenshot was successfully captured — a proxy for "the page renders", not an actual
 * assessment of visual quality/aesthetics (that would require image analysis this extractor
 * doesn't perform).
 */
function checkScreenshotCaptured(page: CrawledPageData): NormalizedEvidence {
  const captured = Boolean(page.screenshotPath);
  return {
    url: page.requestedUrl,
    category: "brand_experience",
    source: "visual_presentation_capture",
    severity: captured ? "info" : "minor",
    finding: captured
      ? "A full-page screenshot was captured for visual review (this does not assess aesthetic quality automatically — see the screenshot itself)."
      : "not detected — a screenshot could not be captured for this page, so visual presentation could not even be reviewed manually.",
    rawData: { captured, screenshotPath: page.screenshotPath },
    confidence: 1,
    recommendationText: captured
      ? null
      : "Investigate why this page failed to render for a screenshot — it may indicate a rendering error visitors also experience.",
  };
}

/**
 * Proxy for "clarity of positioning": a specific (not just brand-name-only) H1, a concise lead
 * paragraph, and a real meta description together suggest a visitor can quickly tell what this
 * business does. This can't confirm the positioning is actually compelling or accurate — only
 * that the structural ingredients for clear positioning are present.
 */
function checkClarityOfPositioning(page: CrawledPageData): NormalizedEvidence {
  const hasSpecificH1 = Boolean(page.h1 && page.h1.trim().length >= 15);
  const hasLeadParagraph = page.hasShortLeadParagraph;
  const hasMetaDescription = Boolean(page.metaDescription && page.metaDescription.trim().length >= 20);
  const signals = [hasSpecificH1, hasLeadParagraph, hasMetaDescription].filter(Boolean).length;
  const clear = signals >= 2;

  return {
    url: page.requestedUrl,
    category: "brand_experience",
    source: "clarity_of_positioning",
    severity: clear ? "info" : "moderate",
    finding: clear
      ? `Positioning appears clear: this page combines ${signals}/3 of a specific H1, a concise lead paragraph, and a real meta description.`
      : `Positioning clarity could not be confirmed: only ${signals}/3 of a specific H1, a concise lead paragraph, and a real meta description were found.`,
    rawData: { hasSpecificH1, hasLeadParagraph, hasMetaDescription },
    // Structural proxy only — doesn't evaluate whether the positioning statement is actually
    // compelling, accurate, or differentiated (see differentiation_language for that angle).
    confidence: 0.6,
    recommendationText: clear
      ? null
      : "Make sure the H1, an early lead paragraph, and the meta description each clearly state who this is for and what it does.",
  };
}

/**
 * Deliberately cross-references signals also used elsewhere (extractConversion.ts's
 * trust_elements, extractAiDiscoverability.ts's trust_signals) — viewed here through a brand
 * credibility lens rather than a conversion or AI-parseability lens.
 */
function checkTrustSignals(page: CrawledPageData): NormalizedEvidence {
  const trustImages = page.images.filter((img) => img.alt && TRUST_IMAGE_ALT_PATTERN.test(img.alt));
  const hasPhone = page.contactLinks.some((l) => l.toLowerCase().startsWith("tel:"));
  const signals = {
    trustKeywords: page.hasTrustKeywords,
    authorAttribution: page.hasAuthorSignal,
    physicalAddress: page.hasAddressSignal,
    phoneNumber: hasPhone,
    trustImagery: trustImages.length > 0,
  };
  const detected = Object.entries(signals)
    .filter(([, present]) => present)
    .map(([name]) => name);

  return {
    url: page.requestedUrl,
    category: "brand_experience",
    source: "trust_signals",
    severity: detected.length > 0 ? "info" : "moderate",
    finding:
      detected.length > 0
        ? `Brand trust signal(s) found: ${detected.join(", ")}.`
        : "not detected — no credential keywords, author attribution, address, phone, or trust imagery was found on this page.",
    rawData: signals,
    confidence: 0.65,
    recommendationText:
      detected.length === 0
        ? "Add visible trust signals (credentials, team/author info, address, phone, certification logos) to build brand credibility."
        : null,
  };
}

function checkDifferentiationLanguage(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "brand_experience",
    source: "differentiation_language",
    severity: page.hasDifferentiationLanguage ? "info" : "minor",
    finding: page.hasDifferentiationLanguage
      ? "Page uses differentiation-claim language (e.g. \"unique\", \"patented\", \"industry-leading\")."
      : "not detected — no differentiation-claim language was found on this page.",
    rawData: { present: page.hasDifferentiationLanguage },
    // Detects the PRESENCE of differentiation-claim phrasing, not whether the claim is true,
    // substantiated, or actually distinguishes this business from competitors.
    confidence: 0.5,
    recommendationText: page.hasDifferentiationLanguage
      ? null
      : "Clarify what specifically sets this business apart from competitors, and say so explicitly rather than relying on generic marketing language.",
  };
}

function checkProofPoints(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "brand_experience",
    source: "proof_points",
    severity: page.hasProofPoints ? "info" : "moderate",
    finding: page.hasProofPoints
      ? "Page includes quantified proof points (e.g. client counts, years in business, stats)."
      : "not detected — no quantified proof points (client counts, years in business, stats) were found on this page.",
    rawData: { present: page.hasProofPoints },
    confidence: 0.6,
    recommendationText: page.hasProofPoints
      ? null
      : "Add concrete, quantified proof points (years in business, clients served, results achieved) to make claims more credible.",
  };
}

function checkAudienceSpecificity(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "brand_experience",
    source: "audience_specificity",
    severity: page.hasAudienceSpecificity ? "info" : "moderate",
    finding: page.hasAudienceSpecificity
      ? "Page language names a specific target audience or industry."
      : "not detected — no language naming a specific target audience or industry was found on this page (may read as generic).",
    rawData: { present: page.hasAudienceSpecificity },
    confidence: 0.55,
    recommendationText: page.hasAudienceSpecificity
      ? null
      : "Name the specific audience or industry this is for (e.g. \"for busy homeowners\", \"specializing in dental practices\") rather than speaking to everyone generically.",
  };
}

/** Informational only, per instruction — ESG language isn't expected of every business, so its
 * absence is never flagged as a problem. */
function checkEsgSignals(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "brand_experience",
    source: "sustainability_esg_signals",
    severity: "info",
    finding: page.hasEsgSignals
      ? "Page includes sustainability/ESG language."
      : "not detected — no sustainability/ESG language was found on this page (not necessarily applicable to this business).",
    rawData: { present: page.hasEsgSignals },
    confidence: 0.5,
    recommendationText: null,
  };
}

/** Informational only, per instruction — human-centered-design language isn't expected of every
 * business, so its absence is never flagged as a problem. */
function checkHumanCenteredSignals(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "brand_experience",
    source: "human_centered_design_signals",
    severity: "info",
    finding: page.hasHumanCenteredSignals
      ? "Page uses human-centered/empathy-driven language (e.g. \"tailored to you\", \"we listen\")."
      : "not detected — no human-centered/empathy-driven language was found on this page.",
    rawData: { present: page.hasHumanCenteredSignals },
    confidence: 0.45,
    recommendationText: null,
  };
}

function extractOrgNameFromJsonLd(jsonLd: unknown[]): string | null {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      nodes.push(obj);
      if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
    }
  };
  jsonLd.forEach(visit);

  const org = nodes.find((n) => {
    const type = n["@type"];
    const types = Array.isArray(type) ? type : [type];
    return types.some((t) => typeof t === "string" && t.toLowerCase() === "organization");
  });
  const name = org?.name;
  return typeof name === "string" ? name : null;
}

/**
 * Brand-name consistency across pages: the most measurable slice of "consistency of brand
 * language" without deep NLP — checks how often the homepage's brand token (JSON-LD Organization
 * name, else the homepage title's trailing segment, else the H1) recurs in other pages' titles.
 * Doesn't assess voice/tone consistency, only name consistency.
 */
function checkBrandLanguageConsistency(scan: ScanContext, page: CrawledPageData): NormalizedEvidence {
  const orgName = extractOrgNameFromJsonLd(page.jsonLd);
  const titleSegments = (page.title ?? "").split(TITLE_SEPARATOR_PATTERN).filter(Boolean);
  const brandToken = orgName ?? titleSegments[titleSegments.length - 1] ?? page.h1;

  if (!brandToken || brandToken.trim().length < 2) {
    return {
      url: null,
      category: "brand_experience",
      source: "brand_language_consistency",
      severity: "info",
      finding: "not detected — no brand name could be identified (from JSON-LD, title, or H1) to check consistency against.",
      rawData: { brandToken: null },
      confidence: 0.3,
      recommendationText: "Add a consistent brand/organization name to structured data, page titles, and headings.",
    };
  }

  const otherPages = scan.allPages.filter((p) => isCrawlOk(p) && p.requestedUrl !== page.requestedUrl);
  if (otherPages.length === 0) {
    return {
      url: null,
      category: "brand_experience",
      source: "brand_language_consistency",
      severity: "info",
      finding: "not applicable — only one page was successfully crawled, so cross-page brand consistency could not be assessed.",
      rawData: { brandToken, pagesChecked: 0 },
      confidence: 0.3,
      recommendationText: null,
    };
  }

  const needle = brandToken.trim().toLowerCase();
  const matchingPages = otherPages.filter((p) => (p.title ?? "").toLowerCase().includes(needle));
  const ratio = matchingPages.length / otherPages.length;
  const consistent = ratio >= 0.8;

  return {
    url: null,
    category: "brand_experience",
    source: "brand_language_consistency",
    severity: consistent ? "info" : "moderate",
    finding: consistent
      ? `Brand name "${brandToken}" appears consistently in page titles across ${matchingPages.length}/${otherPages.length} other crawled pages.`
      : `Brand name "${brandToken}" appears in only ${matchingPages.length}/${otherPages.length} other crawled pages' titles.`,
    rawData: { brandToken, matchingPages: matchingPages.length, pagesChecked: otherPages.length },
    // Only checks brand-name presence in titles, not voice/tone/terminology consistency.
    confidence: 0.6,
    recommendationText: consistent
      ? null
      : "Include the brand name consistently in every page's title tag so the site reads as one coherent brand.",
  };
}
