import type { CrawledPageData } from "@/lib/crawler-service";
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
};

export type EvidenceExtractor = (scan: ScanContext, page: CrawledPageData) => NormalizedEvidence[];

export function isHomepage(scan: ScanContext, page: CrawledPageData): boolean {
  return page.requestedUrl === scan.homepageUrl;
}

export function isCrawlOk(page: CrawledPageData): boolean {
  return page.crawlStatus === "success" || page.crawlStatus === "redirect";
}
