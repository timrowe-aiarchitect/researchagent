import type { AxeViolationSummary, CrawledPageData } from "@/lib/crawler-service";
import type { Severity } from "@/generated/prisma/enums";
import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

const AUTOMATED_SCREENING_NOTE =
  "This is automated accessibility screening (axe-core), not a full WCAG compliance audit — manual review by a person is still required to confirm compliance.";

const GENERIC_LINK_TEXTS = new Set([
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "click",
  "this link",
  "go",
  "continue reading",
  "details",
  "more info",
  "see more",
]);

/**
 * Accessibility: DOM-derived heuristics (image alt coverage, document language, heading order,
 * form label coverage, link text quality) plus an automated axe-core scan for the homepage and
 * up to AXE_MAX_PRIORITY_PAGES other priority pages (see lib/crawler-service.ts). axe-core
 * findings are grouped by rule (axe's own result shape already does this — one violation entry
 * per rule with all affected elements) and severity is mapped from axe's impact rating.
 *
 * Per instruction: nothing here claims full WCAG compliance — every axe-derived finding states
 * plainly that it's automated screening, since axe-core only catches a subset of WCAG success
 * criteria that are programmatically detectable.
 */
export const extractAccessibility: EvidenceExtractor = (_scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];

  items.push(checkImageAltText(page));
  items.push(checkHtmlLangAttribute(page));
  items.push(checkHeadingOrder(page));
  items.push(checkFormLabelCoverage(page));
  items.push(checkLinkTextQuality(page));

  const axeStatus = buildAxeStatusEvidence(page);
  if (axeStatus) items.push(axeStatus);
  if (page.axeViolations) {
    items.push(...page.axeViolations.map((v) => buildAxeViolationEvidence(page, v)));
  }

  return items;
};

function checkImageAltText(page: CrawledPageData): NormalizedEvidence {
  const imgTotal = page.images.length;
  const imgWithAlt = page.images.filter((img) => Boolean(img.alt && img.alt.trim())).length;
  const imagesOk = imgTotal === 0 || imgWithAlt === imgTotal;
  return {
    url: page.requestedUrl,
    category: "accessibility",
    source: "image_alt_text",
    severity: imagesOk ? "info" : "moderate",
    finding: `${imgWithAlt} of ${imgTotal} images on this page have alt text.`,
    rawData: { total: imgTotal, withAlt: imgWithAlt },
    confidence: 1,
    recommendationText:
      imgTotal > 0 && !imagesOk ? "Add descriptive alt text to all meaningful images." : null,
  };
}

function checkHtmlLangAttribute(page: CrawledPageData): NormalizedEvidence {
  const hasLang = Boolean(page.htmlLang);
  return {
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
  };
}

/**
 * Checks heading LEVEL ORDER (e.g. h2 -> h4 skipping h3), distinct from h1 presence/count —
 * those are owned by extractOnPageSeo.ts's missing_h1/multiple_h1 checks and intentionally not
 * duplicated here.
 */
function checkHeadingOrder(page: CrawledPageData): NormalizedEvidence {
  const seq = page.headingSequence;
  if (seq.length === 0) {
    return {
      url: page.requestedUrl,
      category: "accessibility",
      source: "heading_order",
      severity: "info",
      finding: "not detected — no headings were found on this page to check ordering.",
      rawData: { headingSequence: seq },
      confidence: 0.3,
      recommendationText: null,
    };
  }

  const skips: { from: number; to: number }[] = [];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] > seq[i - 1] + 1) skips.push({ from: seq[i - 1], to: seq[i] });
  }
  const hasSkips = skips.length > 0;

  return {
    url: page.requestedUrl,
    category: "accessibility",
    source: "heading_order",
    severity: hasSkips ? "moderate" : "info",
    finding: hasSkips
      ? `Heading levels skip ${skips.length} time(s) (e.g. h${skips[0].from} to h${skips[0].to}), which can confuse screen reader navigation.`
      : "Heading levels progress without skipping (e.g. no h2 directly to h4).",
    rawData: { headingSequence: seq, skips },
    confidence: 0.9,
    recommendationText: hasSkips
      ? "Use heading levels in sequential order (don't skip levels, e.g. h2 to h4) so the document outline is clear to screen reader users."
      : null,
  };
}

function checkFormLabelCoverage(page: CrawledPageData): NormalizedEvidence {
  const { formFieldTotal, formFieldLabelled } = page;
  if (formFieldTotal === 0) {
    return {
      url: page.requestedUrl,
      category: "accessibility",
      source: "form_label_coverage",
      severity: "info",
      finding: "No form fields were found on this page.",
      rawData: { total: 0, labelled: 0 },
      confidence: 1,
      recommendationText: null,
    };
  }

  const coverageOk = formFieldLabelled === formFieldTotal;
  return {
    url: page.requestedUrl,
    category: "accessibility",
    source: "form_label_coverage",
    severity: coverageOk ? "info" : "major",
    finding: `${formFieldLabelled} of ${formFieldTotal} form field(s) have an accessible label (a <label>, aria-label, or aria-labelledby).`,
    rawData: { total: formFieldTotal, labelled: formFieldLabelled },
    confidence: 0.9,
    recommendationText: coverageOk
      ? null
      : "Add <label> elements (or aria-label/aria-labelledby) to every form field so screen reader users know what to enter.",
  };
}

function checkLinkTextQuality(page: CrawledPageData): NormalizedEvidence {
  const links = page.linkTexts;
  const nonDescriptive = links.filter((l) => l.text && GENERIC_LINK_TEXTS.has(l.text.toLowerCase()));
  const emptyAccessibleName = links.filter((l) => !l.hasAccessibleName);
  const hasIssues = nonDescriptive.length > 0 || emptyAccessibleName.length > 0;
  const severity: Severity =
    emptyAccessibleName.length > 0 ? "moderate" : nonDescriptive.length > 0 ? "minor" : "info";

  return {
    url: page.requestedUrl,
    category: "accessibility",
    source: "link_text_quality",
    severity,
    finding: hasIssues
      ? `${nonDescriptive.length} link(s) use non-descriptive text (e.g. "click here") and ${emptyAccessibleName.length} link(s) have no accessible name (no text or aria-label).`
      : `All ${links.length} link(s) on this page have descriptive, accessible text.`,
    rawData: {
      totalLinks: links.length,
      nonDescriptiveCount: nonDescriptive.length,
      emptyAccessibleNameCount: emptyAccessibleName.length,
      sampleNonDescriptive: nonDescriptive.slice(0, 5).map((l) => l.text),
    },
    confidence: 0.8,
    recommendationText: hasIssues
      ? 'Replace generic link text ("click here", "read more") with text that makes sense out of context, and add aria-label to icon-only or otherwise empty links.'
      : null,
  };
}

function axeImpactToSeverity(impact: AxeViolationSummary["impact"]): Severity {
  switch (impact) {
    case "critical":
      return "critical";
    case "serious":
      return "major";
    case "moderate":
      return "moderate";
    case "minor":
      return "minor";
    default:
      return "moderate";
  }
}

function buildAxeViolationEvidence(
  page: CrawledPageData,
  violation: AxeViolationSummary
): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "accessibility",
    source: `axe_${violation.ruleId}`,
    severity: axeImpactToSeverity(violation.impact),
    finding: `Automated screening found a "${violation.ruleId}" issue affecting ${violation.affectedElementCount} element(s) on this page (impact: ${violation.impact ?? "unknown"}): ${violation.description} ${AUTOMATED_SCREENING_NOTE}`,
    rawData: {
      ruleId: violation.ruleId,
      impact: violation.impact,
      affectedElementCount: violation.affectedElementCount,
      helpUrl: violation.helpUrl,
    },
    confidence: 0.9,
    recommendationText: `Fix the "${violation.ruleId}" issue (${violation.affectedElementCount} element(s) affected): ${violation.description} See ${violation.helpUrl} for guidance.`,
  };
}

/** Returns a status finding for the "no violations" / "scan failed" cases; null if axe wasn't run
 * on this page at all (outside the priority sample) or if there are violations to report individually. */
function buildAxeStatusEvidence(page: CrawledPageData): NormalizedEvidence | null {
  if (page.axeViolations === null && page.axeError === null) return null;

  if (page.axeError !== null) {
    return {
      url: page.requestedUrl,
      category: "accessibility",
      source: "axe_core_scan",
      severity: "info",
      finding: `not detected — automated axe-core accessibility screening could not complete on this page (${page.axeError}).`,
      rawData: { attempted: true, error: page.axeError },
      confidence: 0.2,
      recommendationText: null,
    };
  }

  if (page.axeViolations && page.axeViolations.length === 0) {
    return {
      url: page.requestedUrl,
      category: "accessibility",
      source: "axe_core_scan",
      severity: "info",
      finding: `Automated screening found no axe-core violations on this page. ${AUTOMATED_SCREENING_NOTE}`,
      rawData: { attempted: true, violationCount: 0 },
      confidence: 0.85,
      recommendationText: null,
    };
  }

  return null;
}
