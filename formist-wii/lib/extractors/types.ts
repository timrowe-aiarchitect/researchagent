import type { CrawledPageData, HttpsRedirectCheck, WordPressDiagnostics } from "@/lib/crawler-service";
import type { PageSpeedResult } from "@/lib/pagespeed-service";
import type { EvidenceCategory, Severity } from "@/generated/prisma/enums";

/**
 * Evidence-collection only — mirrors the EvidenceItem columns (category, source, severity,
 * finding, url, rawData, confidence) plus a recommendationText that is NOT persisted on
 * EvidenceItem itself; the pipeline carries it through only to seed Recommendation rows.
 * No scoring happens here — see lib/scoring.ts for that.
 */
export type NormalizedEvidence = {
  url: string | null;
  category: EvidenceCategory;
  source: string;
  severity: Severity;
  finding: string;
  rawData: Record<string, unknown> | null;
  confidence: number;
  recommendationText: string | null;
};

/** The scan-level facts an extractor needs alongside the specific page it's evaluating. */
export type ScanContext = {
  scanId: string;
  rootUrl: string;
  homepageUrl: string;
  robotsFound: boolean;
  robotsTxtContent: string | null;
  sitemapFound: boolean;
  llmsTxtFound: boolean;
  /** All pages crawled in this scan — needed for cross-page checks like title uniqueness. */
  allPages: CrawledPageData[];
  /** Passive WordPress diagnostic fetches — null when the homepage wasn't detected as WordPress. */
  wordpressDiagnostics: WordPressDiagnostics | null;
  /**
   * PageSpeed Insights results for the homepage plus up to PSI_MAX_PRIORITY_PAGES other priority
   * pages, keyed by requestedUrl. Pages not selected for PSI analysis have no entry here.
   */
  pageSpeedResults: Record<string, { mobile: PageSpeedResult; desktop: PageSpeedResult }>;
  /** A single passive check of whether plain-HTTP requests to the site get redirected to HTTPS. */
  httpsRedirectCheck: HttpsRedirectCheck;
};

export type EvidenceExtractor = (scan: ScanContext, page: CrawledPageData) => NormalizedEvidence[];

export function isHomepage(scan: ScanContext, page: CrawledPageData): boolean {
  return page.requestedUrl === scan.homepageUrl;
}

export function isCrawlOk(page: CrawledPageData): boolean {
  return page.crawlStatus === "success" || page.crawlStatus === "redirect";
}
