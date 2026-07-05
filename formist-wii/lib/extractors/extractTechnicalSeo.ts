import type { CrawledPageData } from "@/lib/crawler-service";
import type { EvidenceExtractor, NormalizedEvidence, ScanContext } from "./types";
import { isCrawlOk, isHomepage } from "./types";

/**
 * Technical SEO: crawlability, indexability, and site architecture — robots.txt/sitemap.xml,
 * HTTP status health, redirect chains, canonical correctness, noindex directives, internal
 * link health. Per docs/PRD-website-intelligence-index-mvp.md §7, title tags, meta descriptions,
 * and heading hierarchy belong to On-page SEO, not here — see extractOnPageSeo.ts. Keeping them
 * out of this file avoids scoring the same fact twice across two category weights.
 *
 * The brief for this extractor asks for "critical / warning / info" severities. The schema's
 * Severity enum is info | minor | moderate | major | critical (no distinct "warning" value), so
 * "warning" is mapped to "moderate" throughout — the closest existing tier. Only info/moderate/
 * critical are used here; minor/major are left to other extractors.
 */
export const extractTechnicalSeo: EvidenceExtractor = (scan, page) => {
  const items: NormalizedEvidence[] = [];

  items.push(...checkStatusAndReachability(page));

  if (!isCrawlOk(page)) {
    // Nothing else below is observable on a page that never rendered.
    return items;
  }

  items.push(checkIndexability(page));
  items.push(checkNoindexDirective(page));
  items.push(checkRedirectChain(page));
  items.push(...checkCanonical(page));
  items.push(...checkInternalBrokenLinks(scan, page));

  if (!isHomepage(scan, page)) {
    const orphanCheck = checkOrphanRisk(scan, page);
    if (orphanCheck) items.push(orphanCheck);
  }

  if (isHomepage(scan, page)) {
    items.push(checkRobotsTxt(scan));
    items.push(checkSitemapXml(scan));
  }

  return items;
};

function checkStatusAndReachability(page: CrawledPageData): NormalizedEvidence[] {
  if (!isCrawlOk(page)) {
    return [
      {
        url: page.requestedUrl,
        category: "technical_seo",
        source: "page_reachable",
        severity: "critical",
        finding: `Page could not be crawled successfully (${page.crawlStatus}).`,
        rawData: { crawlStatus: page.crawlStatus, httpStatus: page.httpStatus },
        confidence: 1,
        recommendationText: "Fix the underlying error so the page resolves with a 200 status.",
      },
    ];
  }

  const status = page.httpStatus;
  const severity = status === null ? "critical" : status >= 400 ? "critical" : status >= 300 ? "moderate" : "info";
  return [
    {
      url: page.requestedUrl,
      category: "technical_seo",
      source: "status_code",
      severity,
      finding: status !== null ? `Page responded with HTTP ${status}.` : "Page did not return an HTTP status.",
      rawData: { httpStatus: status },
      confidence: 1,
      recommendationText:
        severity === "info"
          ? null
          : status !== null && status >= 400
            ? "Fix the server error or broken route so this page returns a 200 status."
            : "Investigate why this page did not resolve cleanly.",
    },
  ];
}

function checkIndexability(page: CrawledPageData): NormalizedEvidence {
  const isNoindexed = hasNoindexDirective(page);
  const httpOk = page.httpStatus !== null && page.httpStatus < 400;
  const indexable = httpOk && !isNoindexed;
  return {
    url: page.requestedUrl,
    category: "technical_seo",
    source: "indexable_pages",
    severity: indexable ? "info" : "critical",
    finding: indexable
      ? "Page is indexable (successful status, no noindex directive)."
      : `Page is not indexable (${isNoindexed ? "noindex directive present" : `HTTP ${page.httpStatus}`}).`,
    rawData: { indexable, httpStatus: page.httpStatus, noindexed: isNoindexed },
    confidence: 1,
    recommendationText: indexable
      ? null
      : "Remove the noindex directive or fix the status code if this page should appear in search results.",
  };
}

function hasNoindexDirective(page: CrawledPageData): boolean {
  const metaRobots = (page.metaRobots ?? "").toLowerCase();
  const xRobotsTag = (page.headers["x-robots-tag"] ?? "").toLowerCase();
  return metaRobots.includes("noindex") || xRobotsTag.includes("noindex");
}

function checkNoindexDirective(page: CrawledPageData): NormalizedEvidence {
  const isNoindexed = hasNoindexDirective(page);
  return {
    url: page.requestedUrl,
    category: "technical_seo",
    source: "noindex_directive",
    severity: isNoindexed ? "critical" : "info",
    finding: isNoindexed
      ? `A noindex directive was found (meta robots: "${page.metaRobots ?? ""}", X-Robots-Tag: "${page.headers["x-robots-tag"] ?? ""}").`
      : "No noindex directive was found.",
    rawData: { metaRobots: page.metaRobots, xRobotsTag: page.headers["x-robots-tag"] ?? null },
    confidence: 1,
    recommendationText: isNoindexed
      ? "Confirm this page is intentionally excluded from search results; remove the directive if not."
      : null,
  };
}

function checkRedirectChain(page: CrawledPageData): NormalizedEvidence {
  const hops = page.redirectChainLength;
  const severity = hops >= 2 ? "moderate" : "info";
  return {
    url: page.requestedUrl,
    category: "technical_seo",
    source: "redirect_chain",
    severity,
    finding:
      hops === 0
        ? "Page loaded directly with no redirect."
        : `Page went through ${hops} redirect hop(s) before reaching ${page.finalUrl}.`,
    rawData: { redirectChainLength: hops, finalUrl: page.finalUrl },
    confidence: 1,
    recommendationText:
      hops >= 2 ? "Collapse multi-hop redirect chains into a single direct redirect." : null,
  };
}

function checkCanonical(page: CrawledPageData): NormalizedEvidence[] {
  const canonical = page.canonical;
  if (!canonical) {
    return [
      {
        url: page.requestedUrl,
        category: "technical_seo",
        source: "canonical_missing",
        severity: "moderate",
        finding: "No canonical tag found.",
        rawData: { canonical: null },
        confidence: 1,
        recommendationText:
          "Add a self-referencing canonical tag to avoid duplicate content ambiguity.",
      },
    ];
  }

  let crossDomain = false;
  try {
    const canonicalUrl = new URL(canonical, page.requestedUrl);
    const pageOrigin = new URL(page.requestedUrl).origin;
    crossDomain = canonicalUrl.origin !== pageOrigin;
  } catch {
    // Malformed canonical href — flagged separately below via crossDomain staying false but
    // the raw value is still surfaced in rawData for investigation.
  }

  return [
    {
      url: page.requestedUrl,
      category: "technical_seo",
      source: "canonical_cross_domain",
      severity: crossDomain ? "critical" : "info",
      finding: crossDomain
        ? `Canonical points to a different domain: ${canonical}`
        : `Canonical URL: ${canonical}`,
      rawData: { canonical, crossDomain },
      confidence: 0.9,
      recommendationText: crossDomain
        ? "Confirm this cross-domain canonical is intentional — it tells search engines to index the other domain's URL instead of this one."
        : null,
    },
  ];
}

function checkRobotsTxt(scan: ScanContext): NormalizedEvidence {
  return {
    url: null,
    category: "technical_seo",
    source: "robots_txt",
    severity: scan.robotsFound ? "info" : "moderate",
    finding: scan.robotsFound
      ? "robots.txt is present and does not block crawling entirely."
      : "No robots.txt file was found.",
    rawData: { present: scan.robotsFound },
    confidence: 1,
    recommendationText: scan.robotsFound ? null : "Add a robots.txt file at the site root.",
  };
}

function checkSitemapXml(scan: ScanContext): NormalizedEvidence {
  return {
    url: null,
    category: "technical_seo",
    source: "sitemap_xml",
    severity: scan.sitemapFound ? "info" : "moderate",
    finding: scan.sitemapFound
      ? "sitemap.xml was found at the site root."
      : "No sitemap.xml was found at the site root.",
    rawData: { present: scan.sitemapFound },
    confidence: 1,
    recommendationText: scan.sitemapFound
      ? null
      : "Publish an XML sitemap and reference it from robots.txt.",
  };
}

/** Only flags links to URLs that were themselves crawled in this scan and came back broken. */
function checkInternalBrokenLinks(scan: ScanContext, page: CrawledPageData): NormalizedEvidence[] {
  const statusByUrl = new Map<string, CrawledPageData>();
  for (const p of scan.allPages) statusByUrl.set(p.requestedUrl, p);

  const brokenLinks = page.internalLinks.filter((link) => {
    const target = statusByUrl.get(link);
    return target && !isCrawlOk(target);
  });

  if (brokenLinks.length === 0 && page.internalLinks.length === 0) return [];

  return [
    {
      url: page.requestedUrl,
      category: "technical_seo",
      source: "internal_broken_links",
      severity: brokenLinks.length > 0 ? "critical" : "info",
      finding:
        brokenLinks.length > 0
          ? `${brokenLinks.length} internal link(s) on this page point to pages that failed to crawl.`
          : "No broken internal links detected among crawled pages.",
      rawData: { brokenLinks },
      // Only covers links to URLs that were also crawled in this scan — not a full site check.
      confidence: 0.7,
      recommendationText:
        brokenLinks.length > 0 ? "Fix or remove internal links pointing to broken pages." : null,
    },
  ];
}

/** Orphan risk: no other crawled page links to this one. Not meaningful for a single-page crawl. */
function checkOrphanRisk(scan: ScanContext, page: CrawledPageData): NormalizedEvidence | null {
  const successfulPages = scan.allPages.filter(isCrawlOk);
  if (successfulPages.length < 2) return null;

  const inboundCount = successfulPages.filter(
    (p) => p.requestedUrl !== page.requestedUrl && p.internalLinks.includes(page.requestedUrl)
  ).length;

  const atRisk = inboundCount === 0;
  return {
    url: page.requestedUrl,
    category: "technical_seo",
    source: "orphan_risk",
    severity: atRisk ? "moderate" : "info",
    finding: atRisk
      ? "No other crawled page links to this page — it may be an orphaned page."
      : `${inboundCount} crawled page(s) link to this page.`,
    rawData: { inboundCount },
    // Based only on the crawled sample (up to 25 pages), not the full site's link graph.
    confidence: 0.6,
    recommendationText: atRisk
      ? "Link to this page from other relevant pages so it isn't stranded."
      : null,
  };
}
