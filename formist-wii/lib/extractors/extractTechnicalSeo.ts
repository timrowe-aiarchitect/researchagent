import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk, isHomepage } from "./types";

/**
 * Technical SEO: is the page reachable and crawlable at all, and does it declare a canonical.
 * robots.txt / sitemap.xml are site-wide facts, so they're only emitted once, on the homepage.
 */
export const extractTechnicalSeo: EvidenceExtractor = (scan, page) => {
  const items: NormalizedEvidence[] = [];

  if (!isCrawlOk(page)) {
    items.push({
      url: page.requestedUrl,
      category: "technical_seo",
      source: "page_reachable",
      severity: "major",
      finding: `Page could not be crawled successfully (${page.crawlStatus}).`,
      rawData: { crawlStatus: page.crawlStatus, httpStatus: page.httpStatus },
      confidence: 1,
      recommendationText: "Fix the underlying error so the page resolves with a 200 status.",
    });
    // Nothing else on this page is observable if it never rendered.
    return items;
  }

  const canonical = page.canonical;
  items.push({
    url: page.requestedUrl,
    category: "technical_seo",
    source: "canonical_tag",
    severity: canonical ? "info" : "minor",
    finding: canonical ? `Canonical URL: ${canonical}` : "No canonical tag found.",
    rawData: { canonical },
    confidence: 1,
    recommendationText: canonical
      ? null
      : "Add a self-referencing canonical tag to avoid duplicate content ambiguity.",
  });

  if (isHomepage(scan, page)) {
    items.push(
      {
        url: null,
        category: "technical_seo",
        source: "robots_txt",
        severity: scan.robotsFound ? "info" : "minor",
        finding: scan.robotsFound
          ? "robots.txt is present and does not block crawling entirely."
          : "No robots.txt file was found.",
        rawData: { present: scan.robotsFound },
        confidence: 1,
        recommendationText: scan.robotsFound ? null : "Add a robots.txt file at the site root.",
      },
      {
        url: null,
        category: "technical_seo",
        source: "sitemap_xml",
        severity: scan.sitemapFound ? "info" : "minor",
        finding: scan.sitemapFound
          ? "sitemap.xml was found at the site root."
          : "No sitemap.xml was found at the site root.",
        rawData: { present: scan.sitemapFound },
        confidence: 1,
        recommendationText: scan.sitemapFound
          ? null
          : "Publish an XML sitemap and reference it from robots.txt.",
      }
    );
  }

  return items;
};
