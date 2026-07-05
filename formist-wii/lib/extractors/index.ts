import type { CrawledPageData } from "@/lib/crawler-service";
import type { EvidenceExtractor, NormalizedEvidence, ScanContext } from "./types";

export { extractTechnicalSeo } from "./extractTechnicalSeo";
export { extractOnPageSeo } from "./extractOnPageSeo";
export { extractAiDiscoverability } from "./extractAiDiscoverability";
export { extractPerformance } from "./extractPerformance";
export { extractAccessibility } from "./extractAccessibility";
export { extractSecurity } from "./extractSecurity";
export { extractAnalytics } from "./extractAnalytics";
export { extractWordPress } from "./extractWordPress";
export { extractBrandExperience } from "./extractBrandExperience";
export { extractConversion } from "./extractConversion";
export type { EvidenceExtractor, NormalizedEvidence, ScanContext } from "./types";

import { extractTechnicalSeo } from "./extractTechnicalSeo";
import { extractOnPageSeo } from "./extractOnPageSeo";
import { extractAiDiscoverability } from "./extractAiDiscoverability";
import { extractPerformance } from "./extractPerformance";
import { extractAccessibility } from "./extractAccessibility";
import { extractSecurity } from "./extractSecurity";
import { extractAnalytics } from "./extractAnalytics";
import { extractWordPress } from "./extractWordPress";
import { extractBrandExperience } from "./extractBrandExperience";
import { extractConversion } from "./extractConversion";

export const ALL_EXTRACTORS: EvidenceExtractor[] = [
  extractTechnicalSeo,
  extractOnPageSeo,
  extractAiDiscoverability,
  extractPerformance,
  extractAccessibility,
  extractSecurity,
  extractAnalytics,
  extractWordPress,
  extractBrandExperience,
  extractConversion,
];

/** Runs every category extractor for a single page and flattens the results. */
export function extractAllEvidenceForPage(
  scan: ScanContext,
  page: CrawledPageData
): NormalizedEvidence[] {
  return ALL_EXTRACTORS.flatMap((extractor) => extractor(scan, page));
}
