import type { CrawledPageData } from "@/lib/crawler-service";
import type { EvidenceExtractor, NormalizedEvidence, ScanContext } from "./types";
import { isCrawlOk, isHomepage } from "./types";

const VAGUE_CTA_TEXTS = new Set([
  "learn more",
  "click here",
  "read more",
  "more",
  "submit",
  "go",
  "more info",
  "here",
  "continue",
  "next",
  "more details",
]);

const BOOKING_KEYWORD_PATTERN = /\b(book|booking|schedule|appointment|reserve|reservation)\b/i;
const BOOKING_DOMAIN_PATTERN =
  /calendly\.com|acuityscheduling\.com|squareup\.com\/appointments|setmore\.com|schedulicity\.com|simplybook\.me|bookingbug\.com|zcal\.co|cal\.com/i;

const TRUST_IMAGE_ALT_PATTERN = /logo|award|badge|certifi|accredit/i;
const LONG_FORM_FIELD_THRESHOLD = 7;

/**
 * Conversion: contact affordances, CTA presence/clarity/placement, and trust/social-proof
 * signals — all evidence-only, no scoring here (see lib/scoring.ts). Several checks are
 * necessarily heuristic proxies rather than exact measurements (see individual comments below);
 * confidence is reduced accordingly rather than asserting certainty we don't have.
 */
export const extractConversion: EvidenceExtractor = (scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [
    checkContactFormPresence(page),
    checkPhoneEmailVisibility(page),
    checkCtaPresence(page),
    checkCtaTextClarity(page),
    checkBookingAppointmentLinks(page),
    checkLeadMagnetPresence(page),
    checkFormFieldCount(page),
    checkFormLabelCoverage(page),
    checkTrustElements(page),
    checkSocialProofNearCta(page),
  ];

  if (isHomepage(scan, page)) {
    items.push(checkPrimaryCtaAboveFold(page));
    items.push(checkRepeatedCtaPatterns(scan));
    items.push(checkConversionPathServiceToContact(scan));
  }

  return items;
};

function checkContactFormPresence(page: CrawledPageData): NormalizedEvidence {
  const hasForm = page.forms.length > 0;
  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "contact_form_presence",
    severity: hasForm ? "info" : "minor",
    finding: hasForm ? `Page includes ${page.forms.length} form(s).` : "No form was found on this page.",
    rawData: { formCount: page.forms.length },
    confidence: 1,
    recommendationText: hasForm ? null : "Add a contact form so visitors can reach out without leaving the page.",
  };
}

function checkPhoneEmailVisibility(page: CrawledPageData): NormalizedEvidence {
  const hasPhone = page.contactLinks.some((l) => l.toLowerCase().startsWith("tel:"));
  const hasEmail = page.contactLinks.some((l) => l.toLowerCase().startsWith("mailto:"));
  const hasEither = hasPhone || hasEmail;
  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "phone_email_visibility",
    severity: hasEither ? "info" : "minor",
    finding: hasEither
      ? `Visible contact method(s): ${[hasPhone && "phone", hasEmail && "email"].filter(Boolean).join(", ")}.`
      : "No visible phone (tel:) or email (mailto:) link was found on this page.",
    rawData: { hasPhone, hasEmail },
    confidence: 1,
    recommendationText: hasEither
      ? null
      : "Add a visible phone number or email link so visitors can contact you directly.",
  };
}

function checkCtaPresence(page: CrawledPageData): NormalizedEvidence {
  const hasCta = page.buttons.length > 0;
  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "cta_presence",
    severity: hasCta ? "info" : "minor",
    finding: hasCta
      ? `Page has ${page.buttons.length} button(s)/CTA(s): ${page.buttons.slice(0, 3).join(", ")}${page.buttons.length > 3 ? ", …" : ""}`
      : "No buttons or call-to-action elements were found on this page.",
    rawData: { count: page.buttons.length, samples: page.buttons.slice(0, 5) },
    confidence: 1,
    recommendationText: hasCta ? null : "Add a clear call-to-action button so visitors know what to do next.",
  };
}

function checkCtaTextClarity(page: CrawledPageData): NormalizedEvidence {
  if (page.buttons.length === 0) {
    return {
      url: page.requestedUrl,
      category: "conversion",
      source: "cta_text_clarity",
      severity: "info",
      finding: "not applicable — no buttons/CTAs were found on this page.",
      rawData: { totalCtas: 0 },
      confidence: 1,
      recommendationText: null,
    };
  }

  const vague = page.buttons.filter((b) => VAGUE_CTA_TEXTS.has(b.trim().toLowerCase()));
  const hasVague = vague.length > 0;
  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "cta_text_clarity",
    severity: hasVague ? "moderate" : "info",
    finding: hasVague
      ? `${vague.length} of ${page.buttons.length} CTA(s) use vague text without context (e.g. "${[...new Set(vague)].slice(0, 3).join('", "')}").`
      : `All ${page.buttons.length} CTA(s) on this page use specific, descriptive text.`,
    rawData: { totalCtas: page.buttons.length, vagueCtas: [...new Set(vague)] },
    // A fixed list of known-vague phrases — a CTA could still be unclear for reasons this doesn't
    // catch (e.g. jargon, ambiguous verbs), hence < 1.0.
    confidence: 0.75,
    recommendationText: hasVague
      ? 'Replace vague CTA text ("Learn More", "Click Here") with specific, benefit-driven text (e.g. "Get a Free Quote", "Schedule a Consultation").'
      : null,
  };
}

function checkBookingAppointmentLinks(page: CrawledPageData): NormalizedEvidence {
  const linkMatch = [...page.internalLinks, ...page.externalLinks].some((link) => {
    try {
      return BOOKING_KEYWORD_PATTERN.test(new URL(link).pathname) || BOOKING_DOMAIN_PATTERN.test(link);
    } catch {
      return false;
    }
  });
  const buttonMatch = page.buttons.some((b) => BOOKING_KEYWORD_PATTERN.test(b));
  const detected = linkMatch || buttonMatch;

  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "booking_appointment_links",
    severity: detected ? "info" : "minor",
    finding: detected
      ? "A booking/appointment link or scheduling tool was found on this page."
      : "not detected — no booking/appointment/scheduling link was found on this page.",
    rawData: { detected },
    // Not every business needs a booking flow, so absence is a soft nudge (minor), not a real failure.
    confidence: 0.7,
    recommendationText: detected
      ? null
      : "If appointments/consultations are part of the offering, add a booking link (e.g. Calendly) so visitors can self-schedule.",
  };
}

function checkLeadMagnetPresence(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "lead_magnet_presence",
    severity: page.hasLeadMagnet ? "info" : "minor",
    finding: page.hasLeadMagnet
      ? "Page appears to offer a downloadable resource (lead magnet) in exchange for contact info."
      : "not detected — no lead magnet (free guide/ebook/checklist/etc.) language was found on this page.",
    rawData: { present: page.hasLeadMagnet },
    // Text-pattern match against a fixed phrase list — a lead magnet framed differently wouldn't
    // be caught.
    confidence: 0.6,
    recommendationText: page.hasLeadMagnet
      ? null
      : "Consider offering a lead magnet (free guide, checklist, or consultation) to capture contact info from visitors who aren't ready to buy yet.",
  };
}

function checkFormFieldCount(page: CrawledPageData): NormalizedEvidence {
  if (page.forms.length === 0) {
    return {
      url: page.requestedUrl,
      category: "conversion",
      source: "form_field_count",
      severity: "info",
      finding: "not applicable — no forms were found on this page.",
      rawData: { fieldCounts: [] },
      confidence: 1,
      recommendationText: null,
    };
  }

  const fieldCounts = page.forms.map((f) => f.fieldCount);
  const maxFields = Math.max(...fieldCounts);
  const hasLongForm = maxFields > LONG_FORM_FIELD_THRESHOLD;
  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "form_field_count",
    severity: hasLongForm ? "moderate" : "info",
    finding: hasLongForm
      ? `The largest form on this page has ${maxFields} field(s), more than the ~${LONG_FORM_FIELD_THRESHOLD} generally recommended for maximizing completion rates.`
      : `Form field counts on this page (${fieldCounts.join(", ")}) are within a reasonable range.`,
    rawData: { fieldCounts, maxFields },
    confidence: 0.7,
    recommendationText: hasLongForm
      ? "Shorten long forms to only essential fields — every additional field reduces completion rate."
      : null,
  };
}

/**
 * Deliberately cross-references extractAccessibility.ts's form_label_coverage check (same
 * page.formFieldTotal/formFieldLabelled facts) — viewed here through a form-abandonment /
 * conversion lens rather than a WCAG-compliance lens, similar to extractSecurity.ts's WordPress
 * xmlrpc cross-reference.
 */
function checkFormLabelCoverage(page: CrawledPageData): NormalizedEvidence {
  const { formFieldTotal, formFieldLabelled } = page;
  if (formFieldTotal === 0) {
    return {
      url: page.requestedUrl,
      category: "conversion",
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
    category: "conversion",
    source: "form_label_coverage",
    severity: coverageOk ? "info" : "major",
    finding: coverageOk
      ? `All ${formFieldTotal} form field(s) have an accessible label.`
      : `${formFieldTotal - formFieldLabelled} of ${formFieldTotal} form field(s) are missing a label, which can cause confusion and abandoned submissions.`,
    rawData: { total: formFieldTotal, labelled: formFieldLabelled },
    confidence: 0.9,
    recommendationText: coverageOk
      ? null
      : "Add clear labels to every form field — unlabeled fields cause user confusion and lost form submissions.",
  };
}

function checkTrustElements(page: CrawledPageData): NormalizedEvidence {
  const trustImages = page.images.filter((img) => img.alt && TRUST_IMAGE_ALT_PATTERN.test(img.alt));
  const detected = page.hasTrustKeywords || trustImages.length > 0 || page.hasAuthorSignal;
  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "trust_elements",
    severity: detected ? "info" : "moderate",
    finding: detected
      ? "Trust element(s) were found (credential/award/testimonial keywords, client/certification logos, or author attribution)."
      : "not detected — no case studies, testimonials, logos, awards, or certification signals were found on this page.",
    rawData: {
      hasTrustKeywords: page.hasTrustKeywords,
      trustImageCount: trustImages.length,
      hasAuthorSignal: page.hasAuthorSignal,
    },
    confidence: 0.65,
    recommendationText: detected
      ? null
      : "Add trust elements (testimonials, case studies, client logos, awards, or certifications) to build credibility with visitors.",
  };
}

/**
 * Page-level co-occurrence of a CTA and a trust/social-proof signal — not verified DOM
 * adjacency (that would need element-position data this crawler doesn't capture), so this
 * answers "does a page that asks for action also show credibility somewhere", not "is the trust
 * signal literally next to the button". Confidence is reduced accordingly.
 */
function checkSocialProofNearCta(page: CrawledPageData): NormalizedEvidence {
  if (page.buttons.length === 0) {
    return {
      url: page.requestedUrl,
      category: "conversion",
      source: "social_proof_near_cta",
      severity: "info",
      finding: "not applicable — no CTA was found on this page to check for accompanying social proof.",
      rawData: { ctaPresent: false },
      confidence: 0.3,
      recommendationText: null,
    };
  }

  const trustImages = page.images.filter((img) => img.alt && TRUST_IMAGE_ALT_PATTERN.test(img.alt));
  const hasSignal = page.hasTrustKeywords || trustImages.length > 0;
  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "social_proof_near_cta",
    severity: hasSignal ? "info" : "moderate",
    finding: hasSignal
      ? "This page has a CTA and also shows trust/social-proof signals (page-level co-occurrence only — not confirmed to be positioned directly adjacent to the CTA)."
      : "This page has a CTA but no visible trust or social-proof signal was found anywhere on the page.",
    rawData: { ctaPresent: true, trustSignalPresent: hasSignal },
    confidence: 0.5,
    recommendationText: hasSignal
      ? null
      : "Add a testimonial, review, or trust badge near your primary CTA to reduce hesitation and increase conversions.",
  };
}

function checkPrimaryCtaAboveFold(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "conversion",
    source: "primary_cta_above_fold",
    severity: page.hasCtaAboveFold ? "info" : "moderate",
    finding: page.hasCtaAboveFold
      ? "A primary call-to-action is visible above the fold on the homepage."
      : "No call-to-action was found above the fold (within the initial viewport) on the homepage.",
    rawData: { present: page.hasCtaAboveFold },
    // Measured against a fixed 1280x720 viewport (see crawlWebsite()) — actual visitor viewports vary.
    confidence: 0.85,
    recommendationText: page.hasCtaAboveFold
      ? null
      : "Place a clear, primary call-to-action above the fold so visitors see it without scrolling.",
  };
}

function checkRepeatedCtaPatterns(scan: ScanContext): NormalizedEvidence {
  const successfulPages = scan.allPages.filter(isCrawlOk);
  if (successfulPages.length < 2) {
    return {
      url: null,
      category: "conversion",
      source: "repeated_cta_patterns",
      severity: "info",
      finding: "not applicable — fewer than two pages were successfully crawled, so CTA repetition across pages could not be assessed.",
      rawData: { pagesChecked: successfulPages.length },
      confidence: 0.3,
      recommendationText: null,
    };
  }

  const pageCountByText = new Map<string, number>();
  for (const p of successfulPages) {
    const uniqueTexts = new Set(p.buttons.map((b) => b.trim().toLowerCase()).filter(Boolean));
    for (const t of uniqueTexts) pageCountByText.set(t, (pageCountByText.get(t) ?? 0) + 1);
  }
  const repeated = [...pageCountByText.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]);
  const hasRepeated = repeated.length > 0;

  return {
    url: null,
    category: "conversion",
    source: "repeated_cta_patterns",
    severity: hasRepeated ? "info" : "minor",
    finding: hasRepeated
      ? `Consistent CTA text repeats across pages: ${repeated.slice(0, 3).map(([t, c]) => `"${t}" (${c} pages)`).join(", ")}.`
      : "No consistent, repeated call-to-action text was found across the crawled pages.",
    rawData: {
      pagesChecked: successfulPages.length,
      topRepeated: repeated.slice(0, 5).map(([text, count]) => ({ text, count })),
    },
    confidence: 0.7,
    recommendationText: hasRepeated
      ? null
      : 'Use a consistent primary CTA phrase (e.g. "Get a Free Quote") across pages so visitors always know the next step.',
  };
}

function checkConversionPathServiceToContact(scan: ScanContext): NormalizedEvidence {
  const successfulPages = scan.allPages.filter(isCrawlOk);
  const servicePages = successfulPages.filter((p) => /service|offer/i.test(new URL(p.requestedUrl).pathname));
  const contactPages = successfulPages.filter((p) => /contact/i.test(new URL(p.requestedUrl).pathname));

  if (servicePages.length === 0 || contactPages.length === 0) {
    return {
      url: null,
      category: "conversion",
      source: "conversion_path_service_to_contact",
      severity: "info",
      finding: `not applicable — ${servicePages.length === 0 ? "no service/offering pages" : "no contact page"} were found among crawled pages.`,
      rawData: { servicePageCount: servicePages.length, contactPageCount: contactPages.length },
      confidence: 0.5,
      recommendationText: null,
    };
  }

  const contactPaths = new Set(contactPages.map((p) => new URL(p.requestedUrl).pathname));
  const linkedServicePages = servicePages.filter((p) =>
    p.internalLinks.some((link) => {
      try {
        return contactPaths.has(new URL(link).pathname);
      } catch {
        return false;
      }
    })
  );
  const allLinked = linkedServicePages.length === servicePages.length;

  return {
    url: null,
    category: "conversion",
    source: "conversion_path_service_to_contact",
    severity: allLinked ? "info" : "moderate",
    finding: allLinked
      ? `All ${servicePages.length} service page(s) link to a contact page, giving visitors a clear conversion path.`
      : `${servicePages.length - linkedServicePages.length} of ${servicePages.length} service page(s) do not link to a contact page.`,
    rawData: {
      servicePageCount: servicePages.length,
      contactPageCount: contactPages.length,
      linkedServicePageCount: linkedServicePages.length,
    },
    confidence: 0.75,
    recommendationText: allLinked
      ? null
      : "Add a clear link/CTA from every service page to the contact page so interested visitors can convert immediately.",
  };
}
