import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

/** Security: HTTPS enforcement and response security headers, checked per page. */
export const extractSecurity: EvidenceExtractor = (_scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];
  const isHttps = new URL(page.requestedUrl).protocol === "https:";
  items.push({
    url: page.requestedUrl,
    category: "security",
    source: "https_enforced",
    severity: isHttps ? "info" : "critical",
    finding: isHttps ? "Page is served over HTTPS." : "Page is served over plain HTTP.",
    rawData: { scheme: new URL(page.requestedUrl).protocol },
    confidence: 1,
    recommendationText: isHttps ? null : "Serve all pages over HTTPS and redirect HTTP to HTTPS.",
  });

  const headers = page.headers;
  const hasHsts = Boolean(headers["strict-transport-security"]);
  items.push({
    url: page.requestedUrl,
    category: "security",
    source: "hsts_header",
    severity: hasHsts ? "info" : "moderate",
    finding: hasHsts
      ? "Strict-Transport-Security header is present."
      : "Strict-Transport-Security header is missing.",
    rawData: { present: hasHsts },
    confidence: 1,
    recommendationText: hasHsts
      ? null
      : "Add a Strict-Transport-Security header to enforce HTTPS in the browser.",
  });

  const hasCsp = Boolean(headers["content-security-policy"]);
  items.push({
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
  });

  const hasXfo =
    Boolean(headers["x-frame-options"]) ||
    /frame-ancestors/i.test(headers["content-security-policy"] ?? "");
  items.push({
    url: page.requestedUrl,
    category: "security",
    source: "clickjacking_protection",
    severity: hasXfo ? "info" : "minor",
    finding: hasXfo
      ? "X-Frame-Options or frame-ancestors protection is present."
      : "No clickjacking protection (X-Frame-Options / frame-ancestors) was found.",
    rawData: { present: hasXfo },
    confidence: 1,
    recommendationText: hasXfo ? null : "Add X-Frame-Options or a CSP frame-ancestors directive.",
  });

  return items;
};
