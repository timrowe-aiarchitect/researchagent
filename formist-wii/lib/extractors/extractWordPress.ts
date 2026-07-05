import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk, isHomepage } from "./types";

/**
 * WordPress maintainability: only emitted once, from the homepage, when WordPress is detected —
 * otherwise every crawled page would report near-duplicate "WordPress detected" findings.
 */
export const extractWordPress: EvidenceExtractor = (scan, page) => {
  if (!isCrawlOk(page) || !isHomepage(scan, page) || !page.isWordPress) return [];

  const items: NormalizedEvidence[] = [];

  items.push({
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "wp_version_disclosed",
    severity: page.wordpressVersion ? "minor" : "info",
    finding: page.wordpressVersion
      ? `WordPress core version ${page.wordpressVersion} is publicly disclosed via the generator meta tag.`
      : "WordPress was detected but the core version is not publicly disclosed.",
    rawData: { version: page.wordpressVersion },
    confidence: 0.9,
    recommendationText: page.wordpressVersion
      ? "Remove the generator meta tag to avoid advertising the exact core version to attackers."
      : null,
  });

  items.push({
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "plugin_inventory",
    severity: "info",
    finding: `${page.wordpressPlugins.length} plugin(s) detectable from public page markup.`,
    rawData: { plugins: page.wordpressPlugins },
    // Only catches plugins referenced via public asset URLs on this page — not a full inventory.
    confidence: 0.75,
    recommendationText: null,
  });

  return items;
};
