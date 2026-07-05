import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

/** AI discoverability: structured data and Open Graph tags that let AI crawlers/assistants parse the page. */
export const extractAiDiscoverability: EvidenceExtractor = (_scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];
  const hasStructuredData = page.jsonLd.length > 0;
  items.push({
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "structured_data",
    severity: hasStructuredData ? "info" : "moderate",
    finding: hasStructuredData
      ? `Page includes ${page.jsonLd.length} JSON-LD structured data block(s).`
      : "No JSON-LD structured data was found.",
    rawData: { present: hasStructuredData, count: page.jsonLd.length },
    confidence: 1,
    recommendationText: hasStructuredData
      ? null
      : "Add schema.org JSON-LD so AI crawlers and search engines can parse entities reliably.",
  });

  const hasOg = Boolean(page.openGraph["og:title"] || page.openGraph["og:description"]);
  items.push({
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "open_graph_tags",
    severity: hasOg ? "info" : "minor",
    finding: hasOg
      ? "Page declares Open Graph title/description tags."
      : "No Open Graph title/description tags were found.",
    rawData: { present: hasOg, tags: Object.keys(page.openGraph) },
    confidence: 1,
    recommendationText: hasOg
      ? null
      : "Add Open Graph title/description tags so AI assistants and social platforms can summarize this page accurately.",
  });

  return items;
};
