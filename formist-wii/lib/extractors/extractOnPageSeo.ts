import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk, isHomepage } from "./types";

/**
 * On-page SEO: title tags, meta descriptions, and heading hierarchy (presence, length, and
 * uniqueness across the crawl) — per docs/PRD-website-intelligence-index-mvp.md §7.
 *
 * These checks own title/meta/H1 exclusively; extractTechnicalSeo.ts intentionally does not
 * duplicate them (it covers crawlability/indexability instead), so the same fact isn't scored
 * twice across two category weights.
 */
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

  const missingH1 = page.h1Count === 0;
  items.push({
    url: page.requestedUrl,
    category: "on_page_seo",
    source: "missing_h1",
    severity: missingH1 ? "major" : "info",
    finding: missingH1 ? "Page has no <h1> tag." : `Page has ${page.h1Count} <h1> tag(s).`,
    rawData: { h1Count: page.h1Count },
    confidence: 1,
    recommendationText: missingH1
      ? "Add a single <h1> that describes the page's main topic."
      : null,
  });

  const multipleH1 = page.h1Count > 1;
  items.push({
    url: page.requestedUrl,
    category: "on_page_seo",
    source: "multiple_h1",
    severity: multipleH1 ? "minor" : "info",
    finding: multipleH1
      ? `Page has ${page.h1Count} <h1> tags (expected exactly one).`
      : "Page does not have multiple <h1> tags.",
    rawData: { h1Count: page.h1Count },
    confidence: 1,
    recommendationText: multipleH1
      ? "Use exactly one <h1> per page for a clear content hierarchy."
      : null,
  });

  if (isHomepage(scan, page)) {
    const successfulPages = scan.allPages.filter(isCrawlOk);

    const seenTitles = new Map<string, number>();
    for (const p of successfulPages) {
      if (!p.title) continue;
      seenTitles.set(p.title, (seenTitles.get(p.title) ?? 0) + 1);
    }
    const duplicateTitleGroups = [...seenTitles.values()].filter((c) => c > 1).length;
    items.push({
      url: null,
      category: "on_page_seo",
      source: "title_uniqueness",
      severity: duplicateTitleGroups > 0 ? "moderate" : "info",
      finding:
        duplicateTitleGroups > 0
          ? `${duplicateTitleGroups} title(s) are reused across multiple crawled pages.`
          : "All crawled pages have unique title tags.",
      rawData: { duplicateTitleGroups, pagesChecked: successfulPages.length },
      confidence: 1,
      recommendationText:
        duplicateTitleGroups > 0 ? "Give each page a unique, descriptive title tag." : null,
    });

    const seenDescriptions = new Map<string, number>();
    for (const p of successfulPages) {
      if (!p.metaDescription) continue;
      seenDescriptions.set(p.metaDescription, (seenDescriptions.get(p.metaDescription) ?? 0) + 1);
    }
    const duplicateDescriptionGroups = [...seenDescriptions.values()].filter((c) => c > 1).length;
    items.push({
      url: null,
      category: "on_page_seo",
      source: "meta_description_uniqueness",
      severity: duplicateDescriptionGroups > 0 ? "moderate" : "info",
      finding:
        duplicateDescriptionGroups > 0
          ? `${duplicateDescriptionGroups} meta description(s) are reused across multiple crawled pages.`
          : "All crawled pages with a meta description have unique text.",
      rawData: { duplicateDescriptionGroups, pagesChecked: successfulPages.length },
      confidence: 1,
      recommendationText:
        duplicateDescriptionGroups > 0 ? "Write a unique meta description for each page." : null,
    });
  }

  return items;
};
