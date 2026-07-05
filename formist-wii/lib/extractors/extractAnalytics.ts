import type { CrawledPageData, ScriptCapture } from "@/lib/crawler-service";
import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

/**
 * Analytics: public measurement-readiness signals detected from script src/inline-snippet text
 * and page markup. Everything here is a pattern match against publicly-served page content —
 * per instruction, this never requires or uses authenticated GA4 (or any other vendor) API
 * access, so a site can be assessed without the client granting any account access.
 *
 * Vendor detection is necessarily a heuristic (obfuscated/dynamically-injected loaders, or tools
 * outside this known list, won't be caught), reflected in confidence < 1.
 */
type VendorMatcher = { key: string; label: string; pattern: RegExp };

const ANALYTICS_VENDORS: VendorMatcher[] = [
  { key: "google_tag_manager", label: "Google Tag Manager", pattern: /googletagmanager\.com\/gtm\.js|\bGTM-[A-Z0-9]+\b/i },
  { key: "ga4", label: "Google Analytics 4", pattern: /googletagmanager\.com\/gtag\/js\?id=G-|\bG-[A-Z0-9]{6,}\b/i },
  {
    key: "google_ads",
    label: "Google Ads",
    pattern: /googletagmanager\.com\/gtag\/js\?id=AW-|\bAW-\d{6,}\b|google_conversion_id/i,
  },
  {
    key: "meta_pixel",
    label: "Meta Pixel",
    pattern: /connect\.facebook\.net\/[^"'\s]*fbevents\.js|fbq\(\s*['"]init['"]/i,
  },
  {
    key: "linkedin_insight",
    label: "LinkedIn Insight Tag",
    pattern: /snap\.licdn\.com|_linkedin_partner_id|linkedin_data_partner_ids/i,
  },
  { key: "hotjar", label: "Hotjar", pattern: /static\.hotjar\.com|_hjSettings/i },
  { key: "microsoft_clarity", label: "Microsoft Clarity", pattern: /clarity\.ms\/tag/i },
  {
    key: "hubspot",
    label: "HubSpot",
    pattern: /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net/i,
  },
  { key: "segment", label: "Segment", pattern: /cdn\.segment\.com\/analytics\.js/i },
  { key: "plausible", label: "Plausible", pattern: /plausible\.io\/js\/(script|plausible)/i },
  { key: "matomo", label: "Matomo", pattern: /[/.]matomo\.js|[/.]piwik\.js|_paq\.push/i },
];

const CMP_VENDORS: VendorMatcher[] = [
  { key: "onetrust", label: "OneTrust", pattern: /cookielaw\.org|otSDKStub/i },
  { key: "cookiebot", label: "Cookiebot", pattern: /consent\.cookiebot\.com/i },
  { key: "trustarc", label: "TrustArc", pattern: /consent\.trustarc\.com/i },
  { key: "quantcast_choice", label: "Quantcast Choice", pattern: /quantcast\.mgr\.consensu\.org/i },
  { key: "cookieyes", label: "CookieYes", pattern: /cookieyes\.com/i },
  { key: "iubenda", label: "iubenda", pattern: /cdn\.iubenda\.com/i },
  { key: "didomi", label: "Didomi", pattern: /didomi\.io|sdk\.privacy-center\.org/i },
  { key: "usercentrics", label: "Usercentrics", pattern: /usercentrics\.eu/i },
  { key: "termly", label: "Termly", pattern: /app\.termly\.io/i },
  { key: "complianz", label: "Complianz", pattern: /complianz/i },
];

const FORM_TRACKING_PATTERN =
  /hbspt\.forms|js\.hsforms\.net|addEventListener\(\s*['"]submit['"]|onsubmit\s*=|generate_lead|submit_lead_form|form[-_]submit|gform_confirmation_loaded/i;

const EVENT_TRACKING_PATTERN =
  /gtag\(\s*['"]event['"]|fbq\(\s*['"]track(Custom)?['"]|analytics\.track\(|_paq\.push\(\s*\[\s*['"]trackEvent['"]|dataLayer\.push\(\{[^}]*event\s*:|clarity\(\s*['"]event['"]|hj\(\s*['"]event['"]|ga\(\s*['"]send['"],\s*['"]event['"]/i;

function buildScriptHaystack(scripts: ScriptCapture[]): string {
  return scripts.map((s) => `${s.src ?? ""} ${s.snippet ?? ""}`).join(" ");
}

function matchVendors(haystack: string, vendors: VendorMatcher[]): VendorMatcher[] {
  return vendors.filter((v) => v.pattern.test(haystack));
}

export const extractAnalytics: EvidenceExtractor = (_scan, page) => {
  if (!isCrawlOk(page)) return [];

  const haystack = buildScriptHaystack(page.scripts);

  return [
    checkMeasurementStack(page, haystack),
    checkConsentMechanism(page, haystack),
    checkFormTrackingHints(page, haystack),
    checkEventTrackingHints(page, haystack),
  ];
};

function checkMeasurementStack(page: CrawledPageData, haystack: string): NormalizedEvidence {
  const detected = matchVendors(haystack, ANALYTICS_VENDORS);
  const labels = detected.map((v) => v.label);
  return {
    url: page.requestedUrl,
    category: "analytics",
    source: "measurement_stack_detected",
    severity: detected.length > 0 ? "info" : "moderate",
    finding:
      detected.length > 0
        ? `Detected analytics/marketing tag(s) via public page markup: ${labels.join(", ")}. (No authenticated API access to any of these tools is required or used.)`
        : "No recognizable analytics, tag-manager, or marketing pixel was detected on this page.",
    rawData: { detectedVendorKeys: detected.map((v) => v.key), detectedVendorLabels: labels },
    // Pattern-matched against known vendor loaders — a bespoke, self-hosted, or dynamically
    // injected analytics tool would not be caught, hence < 1.0.
    confidence: 0.85,
    recommendationText:
      detected.length === 0
        ? "Install GA4 (or another analytics tool) and a tag manager so traffic and conversions can be measured."
        : null,
  };
}

function checkConsentMechanism(page: CrawledPageData, haystack: string): NormalizedEvidence {
  const cmpMatches = matchVendors(haystack, CMP_VENDORS);
  const cmpDetected = cmpMatches[0]?.label ?? null;
  const genericBanner = page.hasCookieBannerMarkup;
  const hasMechanism = Boolean(cmpDetected) || genericBanner;

  return {
    url: page.requestedUrl,
    category: "analytics",
    source: "consent_mechanism",
    severity: hasMechanism ? "info" : "moderate",
    finding: cmpDetected
      ? `A consent management platform (${cmpDetected}) was detected.`
      : genericBanner
        ? "A cookie/consent banner was detected in the page markup (no known consent-management-platform vendor script was identified)."
        : "not detected — no consent management platform or cookie/consent banner was found on this page.",
    rawData: { cmpDetected, genericBannerDetected: genericBanner },
    // CMP vendor matches are deterministic (known script domains); the generic banner match is a
    // DOM-text heuristic, so overall confidence reflects the weaker of the two paths.
    confidence: cmpDetected ? 0.9 : genericBanner ? 0.6 : 0.7,
    recommendationText: hasMechanism
      ? null
      : "Add a consent management mechanism (banner or CMP) before or alongside analytics/marketing tags, particularly if serving visitors in GDPR/CCPA-applicable regions.",
  };
}

function checkFormTrackingHints(page: CrawledPageData, haystack: string): NormalizedEvidence {
  if (page.forms.length === 0) {
    return {
      url: page.requestedUrl,
      category: "analytics",
      source: "form_tracking_hints",
      severity: "info",
      finding: "not applicable — no forms were found on this page.",
      rawData: { formCount: 0 },
      confidence: 1,
      recommendationText: null,
    };
  }

  const hasHint = FORM_TRACKING_PATTERN.test(haystack);
  return {
    url: page.requestedUrl,
    category: "analytics",
    source: "form_tracking_hints",
    severity: hasHint ? "info" : "moderate",
    finding: hasHint
      ? `Found ${page.forms.length} form(s) on this page along with visible form-tracking hints (e.g. a submit handler or lead/conversion event).`
      : `Found ${page.forms.length} form(s) on this page but no visible hint that submissions are tracked (e.g. no submit-event handler or lead/conversion event was found in scripts).`,
    rawData: { formCount: page.forms.length, hintFound: hasHint },
    // Heuristic pattern match over script text — a form could still be tracked server-side or via
    // a mechanism this doesn't recognize, so this is a "hint", not proof either way.
    confidence: 0.6,
    recommendationText: hasHint
      ? null
      : "Confirm form submissions fire a conversion/lead event in your analytics tool — without this, form-driven conversions won't be measurable.",
  };
}

function checkEventTrackingHints(page: CrawledPageData, haystack: string): NormalizedEvidence {
  const hasHint = EVENT_TRACKING_PATTERN.test(haystack);
  return {
    url: page.requestedUrl,
    category: "analytics",
    source: "event_tracking_hints",
    severity: hasHint ? "info" : "moderate",
    finding: hasHint
      ? "Visible event-tracking calls (e.g. a gtag/fbq/analytics.track event) were found on this page."
      : "not detected — no visible event-tracking calls were found on this page beyond basic pageview tracking.",
    rawData: { hintFound: hasHint },
    // Only catches event calls that appear verbatim in captured script src/inline text — events
    // fired from bundled/minified JS elsewhere on the page won't be visible here.
    confidence: 0.55,
    recommendationText: hasHint
      ? null
      : "Beyond pageviews, track key interactions (clicks, scroll depth, video plays, conversions) as events so engagement can be measured.",
  };
}
