import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

/**
 * Performance: signals derivable without a real Lighthouse/CWV run — measured page load time,
 * external script count as a page-weight proxy, and response compression.
 */
export const extractPerformance: EvidenceExtractor = (_scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];

  const loadTimeMs = page.loadTimeMs;
  const loadSeverity =
    loadTimeMs < 1500 ? "info" : loadTimeMs < 3000 ? "minor" : loadTimeMs < 6000 ? "moderate" : "major";
  items.push({
    url: page.requestedUrl,
    category: "performance",
    source: "page_load_time",
    severity: loadSeverity,
    finding: `Page took ${loadTimeMs}ms to load (navigation to network-idle).`,
    rawData: { loadTimeMs },
    confidence: 1,
    recommendationText:
      loadSeverity === "info"
        ? null
        : "Investigate slow server response times, render-blocking resources, or unoptimized assets.",
  });

  const externalScriptCount = page.scripts.filter((s) => !s.inline).length;
  const scriptSeverity = externalScriptCount > 15 ? "moderate" : externalScriptCount > 8 ? "minor" : "info";
  items.push({
    url: page.requestedUrl,
    category: "performance",
    source: "script_weight",
    severity: scriptSeverity,
    finding: `Page loads ${externalScriptCount} external script(s).`,
    rawData: { externalScriptCount, totalScriptCount: page.scripts.length },
    confidence: 0.7,
    recommendationText:
      scriptSeverity === "info"
        ? null
        : "Reduce the number of separately-loaded scripts, or defer/async non-critical ones.",
  });

  const contentEncoding = page.headers["content-encoding"];
  const isCompressed = Boolean(contentEncoding && /gzip|br|deflate/i.test(contentEncoding));
  items.push({
    url: page.requestedUrl,
    category: "performance",
    source: "response_compression",
    severity: isCompressed ? "info" : "minor",
    finding: isCompressed
      ? `Response is compressed (${contentEncoding}).`
      : "Response does not appear to be compressed.",
    rawData: { contentEncoding: contentEncoding ?? null },
    confidence: 1,
    recommendationText: isCompressed
      ? null
      : "Enable gzip or brotli compression on the server to reduce transfer size.",
  });

  return items;
};
