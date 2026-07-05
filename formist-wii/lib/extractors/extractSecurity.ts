import type { CrawledPageData } from "@/lib/crawler-service";
import type { EvidenceExtractor, NormalizedEvidence, ScanContext } from "./types";
import { isCrawlOk, isHomepage } from "./types";

/**
 * Security: emitted once, from the homepage — response security headers and HTTPS posture are
 * server/CDN-wide configuration, not something that varies meaningfully page to page, so checking
 * every crawled page would just produce near-duplicate findings (same pattern as
 * extractWordPress.ts).
 *
 * Every check here is either read from data already gathered during the normal crawl (headers,
 * scheme, image/script src attributes) or a single passive, non-destructive GET performed once
 * per scan (lib/crawler-service.ts's fetchHttpsRedirectCheck). No vulnerability scanning, brute
 * forcing, or intrusive testing of any kind is performed.
 */
export const extractSecurity: EvidenceExtractor = (scan, page) => {
  if (!isCrawlOk(page) || !isHomepage(scan, page)) return [];

  const items: NormalizedEvidence[] = [];

  items.push(checkHttpsEnforced(page));
  items.push(checkHttpsRedirect(scan));
  items.push(checkHstsHeader(page));
  items.push(checkContentSecurityPolicy(page));
  items.push(checkXContentTypeOptions(page));
  items.push(checkClickjackingProtection(page));
  items.push(checkReferrerPolicy(page));
  items.push(checkPermissionsPolicy(page));
  items.push(checkMixedContent(page));

  const xmlrpcExposure = checkWordpressXmlrpcExposure(scan, page);
  if (xmlrpcExposure) items.push(xmlrpcExposure);

  return items;
};

function checkHttpsEnforced(page: CrawledPageData): NormalizedEvidence {
  const isHttps = new URL(page.finalUrl || page.requestedUrl).protocol === "https:";
  return {
    url: page.requestedUrl,
    category: "security",
    source: "https_enforced",
    severity: isHttps ? "info" : "critical",
    finding: isHttps ? "Homepage is served over HTTPS." : "Homepage is served over plain HTTP.",
    rawData: { scheme: new URL(page.finalUrl || page.requestedUrl).protocol },
    confidence: 1,
    recommendationText: isHttps ? null : "Serve the site over HTTPS and redirect all HTTP traffic to HTTPS.",
  };
}

function checkHttpsRedirect(scan: ScanContext): NormalizedEvidence {
  const { httpReachable, redirectsToHttps, finalUrl } = scan.httpsRedirectCheck;

  if (!httpReachable) {
    return {
      url: scan.homepageUrl,
      category: "security",
      source: "https_redirect",
      severity: "info",
      finding: "Plain HTTP does not appear to be reachable at all for this site, so it cannot be accessed over an insecure channel.",
      rawData: { httpReachable: false, redirectsToHttps: false, finalUrl: null },
      confidence: 0.8,
      recommendationText: null,
    };
  }

  return {
    url: scan.homepageUrl,
    category: "security",
    source: "https_redirect",
    severity: redirectsToHttps ? "info" : "major",
    finding: redirectsToHttps
      ? "Requests to the plain-HTTP version of the site are redirected to HTTPS."
      : `Requests to the plain-HTTP version of the site are NOT redirected to HTTPS (ended at ${finalUrl}).`,
    rawData: { httpReachable, redirectsToHttps, finalUrl },
    confidence: 1,
    recommendationText: redirectsToHttps
      ? null
      : "Add a server-level redirect from HTTP to HTTPS so the site can never be accessed over an unencrypted connection.",
  };
}

function checkHstsHeader(page: CrawledPageData): NormalizedEvidence {
  const hasHsts = Boolean(page.headers["strict-transport-security"]);
  return {
    url: page.requestedUrl,
    category: "security",
    source: "hsts_header",
    severity: hasHsts ? "info" : "moderate",
    finding: hasHsts
      ? "Strict-Transport-Security header is present."
      : "Strict-Transport-Security header is missing.",
    rawData: { present: hasHsts, value: page.headers["strict-transport-security"] ?? null },
    confidence: 1,
    recommendationText: hasHsts
      ? null
      : "Add a Strict-Transport-Security header to enforce HTTPS in the browser.",
  };
}

function checkContentSecurityPolicy(page: CrawledPageData): NormalizedEvidence {
  const hasCsp = Boolean(page.headers["content-security-policy"]);
  return {
    url: page.requestedUrl,
    category: "security",
    source: "content_security_policy",
    severity: hasCsp ? "info" : "minor",
    finding: hasCsp
      ? "Content-Security-Policy header is present."
      : "Content-Security-Policy header is missing.",
    rawData: { present: hasCsp },
    confidence: 1,
    recommendationText: hasCsp ? null : "Add a Content-Security-Policy header to reduce XSS exposure.",
  };
}

function checkXContentTypeOptions(page: CrawledPageData): NormalizedEvidence {
  const value = page.headers["x-content-type-options"];
  const present = Boolean(value && /nosniff/i.test(value));
  return {
    url: page.requestedUrl,
    category: "security",
    source: "x_content_type_options",
    severity: present ? "info" : "minor",
    finding: present
      ? "X-Content-Type-Options: nosniff header is present."
      : "X-Content-Type-Options: nosniff header is missing.",
    rawData: { present, value: value ?? null },
    confidence: 1,
    recommendationText: present
      ? null
      : "Add an 'X-Content-Type-Options: nosniff' header to stop browsers from MIME-sniffing responses.",
  };
}

function checkClickjackingProtection(page: CrawledPageData): NormalizedEvidence {
  const hasXfo =
    Boolean(page.headers["x-frame-options"]) ||
    /frame-ancestors/i.test(page.headers["content-security-policy"] ?? "");
  return {
    url: page.requestedUrl,
    category: "security",
    source: "clickjacking_protection",
    severity: hasXfo ? "info" : "minor",
    finding: hasXfo
      ? "X-Frame-Options or a CSP frame-ancestors directive is present."
      : "No clickjacking protection (X-Frame-Options / frame-ancestors) was found.",
    rawData: { present: hasXfo },
    confidence: 1,
    recommendationText: hasXfo ? null : "Add X-Frame-Options or a CSP frame-ancestors directive.",
  };
}

function checkReferrerPolicy(page: CrawledPageData): NormalizedEvidence {
  const value = page.headers["referrer-policy"];
  const present = Boolean(value);
  return {
    url: page.requestedUrl,
    category: "security",
    source: "referrer_policy",
    severity: present ? "info" : "minor",
    finding: present
      ? `Referrer-Policy header is present (${value}).`
      : "Referrer-Policy header is missing.",
    rawData: { present, value: value ?? null },
    confidence: 1,
    recommendationText: present
      ? null
      : "Add a Referrer-Policy header (e.g. 'strict-origin-when-cross-origin') to limit referrer data leaked to other sites.",
  };
}

function checkPermissionsPolicy(page: CrawledPageData): NormalizedEvidence {
  const value = page.headers["permissions-policy"];
  const present = Boolean(value);
  return {
    url: page.requestedUrl,
    category: "security",
    source: "permissions_policy",
    severity: present ? "info" : "minor",
    finding: present
      ? "Permissions-Policy header is present."
      : "Permissions-Policy header is missing.",
    rawData: { present, value: value ?? null },
    confidence: 1,
    recommendationText: present
      ? null
      : "Add a Permissions-Policy header to explicitly restrict powerful browser features (camera, microphone, geolocation, etc.) the site doesn't use.",
  };
}

/**
 * Mixed content = an HTTPS page loading an explicit http:// sub-resource. Only checks images and
 * scripts (the two resource types already captured on CrawledPageData) — stylesheets, iframes,
 * and fonts aren't captured separately, so this is a partial view, reflected in the confidence.
 */
function checkMixedContent(page: CrawledPageData): NormalizedEvidence {
  const isHttps = new URL(page.finalUrl || page.requestedUrl).protocol === "https:";
  if (!isHttps) {
    return {
      url: page.requestedUrl,
      category: "security",
      source: "mixed_content",
      severity: "info",
      finding: "not applicable — homepage is not served over HTTPS, so mixed content isn't a meaningful check here.",
      rawData: { applicable: false },
      confidence: 1,
      recommendationText: null,
    };
  }

  const insecureImages = page.images.filter((img) => img.src?.startsWith("http://"));
  const insecureScripts = page.scripts.filter((s) => s.src?.startsWith("http://"));
  const total = insecureImages.length + insecureScripts.length;

  return {
    url: page.requestedUrl,
    category: "security",
    source: "mixed_content",
    severity: total > 0 ? "major" : "info",
    finding:
      total > 0
        ? `${total} insecure (http://) resource(s) load on this HTTPS page: ${insecureImages.length} image(s), ${insecureScripts.length} script(s).`
        : "No mixed content (insecure http:// images or scripts) was found on this HTTPS page.",
    rawData: {
      insecureImageCount: insecureImages.length,
      insecureScriptCount: insecureScripts.length,
      sampleUrls: [...insecureImages, ...insecureScripts].slice(0, 5).map((r) => r.src),
    },
    // Only checks images/scripts, not stylesheets, iframes, or fonts — a partial (but common-case) view.
    confidence: 0.7,
    recommendationText:
      total > 0
        ? "Update these resources to use https:// (or protocol-relative/relative URLs) to avoid mixed-content warnings and blocked resources."
        : null,
  };
}

/**
 * Deliberately cross-references lib/extractors/extractWordPress.ts's xmlrpc_availability check —
 * this is the same underlying fact viewed through a different lens (a concrete security exposure
 * on the homepage, vs. a WordPress-maintainability signal) and was explicitly requested to be
 * surfaced in both categories, not an accidental duplicate.
 */
function checkWordpressXmlrpcExposure(
  scan: ScanContext,
  page: CrawledPageData
): NormalizedEvidence | null {
  const diagnostics = scan.wordpressDiagnostics;
  if (!diagnostics?.attempted) return null;

  const { reachable, status } = diagnostics.xmlrpc;
  return {
    url: page.requestedUrl,
    category: "security",
    source: "wordpress_xmlrpc_exposure",
    severity: reachable ? "moderate" : "info",
    finding: reachable
      ? `xmlrpc.php is publicly reachable (HTTP ${status}), a known vector for brute-force and pingback-amplification attacks.`
      : "xmlrpc.php was not reachable, so it does not appear to be an exposed attack surface.",
    rawData: diagnostics.xmlrpc,
    confidence: 0.9,
    recommendationText: reachable
      ? "Disable XML-RPC (via hosting config or a security plugin) unless a specific integration requires it."
      : null,
  };
}
