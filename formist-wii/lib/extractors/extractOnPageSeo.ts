import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk, isHomepage } from "./types";

/** On-page SEO: title tag, meta description, H1 usage, and title uniqueness across the crawl. */
export const extractOnPageSeo: EvidenceExtractor = (scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];
  const title = page.title;
  const titleOk = title !== null && title.length >= 10 && title.length <= 60;
  items.push({
    url: page.requestedUrl,
    category: "on_page_seo",
    source: "title_tag",
    severity: !title ? "major" : titleOk ? "info" : "minor",
    finding: title ? `Title tag: "${title}"` : "No <title> tag found.",
    rawData: { length: title?.length ?? 0 },
    confidence: 1,
    recommendationText: !title
      ? "Add a descriptive title tag (roughly 10-60 characters)."
      : !titleOk
        ? "Adjust the title length to roughly 10-60 characters."
        : null,
  });

  const description = page.metaDescription;
  const descriptionOk = description !== null && description.length <= 160;
  items.push({
    url: page.requestedUrl,
    category: "on_page_seo",
    source: "meta_description",
    severity: !description ? "moderate" : descriptionOk ? "info" : "minor",
    finding: description ? `Meta description: "${description}"` : "No meta description found.",
    rawData: { length: description?.length ?? 0 },
    confidence: 1,
    recommendationText: !description
      ? "Add a meta description summarizing the page in ~150-160 characters."
      : !descriptionOk
        ? "Shorten the meta description to avoid truncation in search results."
        : null,
  });

  items.push({
    url: page.requestedUrl,
    category: "on_page_seo",
    source: "h1_heading",
    severity: page.h1Count === 1 ? "info" : "minor",
    finding: `Page has ${page.h1Count} <h1> tag(s).`,
    rawData: { h1Count: page.h1Count },
    confidence: 1,
    recommendationText:
      page.h1Count === 1 ? null : "Use exactly one <h1> per page for a clear content hierarchy.",
  });

  if (isHomepage(scan, page)) {
    const successfulPages = scan.allPages.filter(isCrawlOk);
    const seenTitles = new Map<string, number>();
    for (const p of successfulPages) {
      if (!p.title) continue;
      seenTitles.set(p.title, (seenTitles.get(p.title) ?? 0) + 1);
    }
    const duplicateTitleCount = [...seenTitles.values()].filter((c) => c > 1).length;
    items.push({
      url: null,
      category: "on_page_seo",
      source: "title_uniqueness",
      severity: duplicateTitleCount > 0 ? "moderate" : "info",
      finding:
        duplicateTitleCount > 0
          ? `${duplicateTitleCount} title(s) are reused across multiple crawled pages.`
          : "All crawled pages have unique title tags.",
      rawData: { duplicateTitleGroups: duplicateTitleCount, pagesChecked: successfulPages.length },
      confidence: 1,
      recommendationText:
        duplicateTitleCount > 0 ? "Give each page a unique, descriptive title tag." : null,
    });
  }

  return items;
};
