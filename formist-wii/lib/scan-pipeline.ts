import { prisma } from "@/lib/prisma";
import {
  detectPluginSlugs,
  detectWordPress,
  extractCanonical,
  extractFaviconPresence,
  extractH1Count,
  extractImgAltCoverage,
  extractLinks,
  extractMetaContent,
  extractTitle,
  fetchPage,
  fetchRobots,
  fetchSitemapPresence,
  hasAnalyticsTag,
  hasContactAffordance,
  hasHtmlLangAttr,
  hasJsonLd,
  hasViewportMeta,
} from "@/lib/crawler";
import {
  computeCategoryScore,
  computeOverallScore,
  deriveAiReadiness,
  deriveBusinessRisk,
  gradeFromScore,
  isPassing,
  statusFromScore,
} from "@/lib/scoring";
import { buildReportHtml } from "@/lib/report-html";
import type { Prisma } from "@/generated/prisma/client";
import type { CrawlStatus, EvidenceCategory, Severity } from "@/generated/prisma/enums";

const MAX_PAGES_HARD_CAP = 25;

type DraftEvidence = {
  url: string | null;
  category: EvidenceCategory;
  source: string;
  severity: Severity;
  finding: string;
  rawData: Record<string, unknown> | null;
  confidence: number;
  // Not persisted on EvidenceItem — carried through only to seed Recommendation rows.
  recommendationText: string | null;
};

export async function runScanPipeline(scanId: string): Promise<void> {
  const scan = await prisma.scan.findUniqueOrThrow({
    where: { id: scanId },
    include: { client: true },
  });

  await prisma.scan.update({
    where: { id: scanId },
    data: { status: "crawling", startedAt: new Date() },
  });

  try {
    const rootUrl = scan.client.rootUrl;
    const origin = new URL(rootUrl).origin;

    const robots = await fetchRobots(origin);
    if (robots.disallowsAll) {
      await prisma.scan.update({
        where: { id: scanId },
        data: {
          status: "failed",
          completedAt: new Date(),
          failureReason:
            "robots.txt disallows crawling for all user agents (Disallow: / under User-agent: *)",
        },
      });
      return;
    }
    const sitemapFound = await fetchSitemapPresence(origin);

    const maxPages = Math.min(scan.pagesRequested, MAX_PAGES_HARD_CAP);
    const visited = new Set<string>();
    const queue: string[] = [rootUrl];
    const draftEvidence: DraftEvidence[] = [];
    const pageTitles: { url: string; title: string | null }[] = [];
    let homepageHtml: string | null = null;
    let homepageHeaders: Record<string, string> = {};
    let crawledCount = 0;

    while (queue.length > 0 && crawledCount < maxPages) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      const fetched = await fetchPage(url);
      crawledCount += 1;

      await prisma.page.create({
        data: {
          scanId,
          url: fetched.requestedUrl,
          finalUrl: fetched.finalUrl,
          httpStatus: fetched.httpStatus,
          crawlStatus: fetched.crawlStatus as CrawlStatus,
          rendered: false,
        },
      });

      if (fetched.crawlStatus !== "success" && fetched.crawlStatus !== "redirect") {
        draftEvidence.push({
          url,
          category: "technical_seo",
          source: "page_reachable",
          severity: "major",
          finding: `Page could not be crawled successfully (${fetched.crawlStatus}).`,
          rawData: { crawlStatus: fetched.crawlStatus, httpStatus: fetched.httpStatus },
          confidence: 1,
          recommendationText: "Fix the underlying error so the page resolves with a 200 status.",
        });
        continue;
      }

      if (url === rootUrl) {
        homepageHtml = fetched.html;
        homepageHeaders = fetched.headers;
      }

      if (!fetched.html) continue;
      const html = fetched.html;

      for (const link of extractLinks(html, fetched.finalUrl)) {
        if (!visited.has(link) && queue.length + crawledCount < maxPages) {
          queue.push(link);
        }
      }

      draftEvidence.push(...buildPageEvidence(url, html));
      pageTitles.push({ url, title: extractTitle(html) });
    }

    // Title uniqueness across the crawled sample (technical_seo / on_page_seo overlap — counted once here).
    const seenTitles = new Map<string, number>();
    for (const { title } of pageTitles) {
      if (!title) continue;
      seenTitles.set(title, (seenTitles.get(title) ?? 0) + 1);
    }
    const duplicateTitleCount = [...seenTitles.values()].filter((c) => c > 1).length;
    draftEvidence.push({
      url: null,
      category: "on_page_seo",
      source: "title_uniqueness",
      severity: duplicateTitleCount > 0 ? "moderate" : "info",
      finding:
        duplicateTitleCount > 0
          ? `${duplicateTitleCount} title(s) are reused across multiple crawled pages.`
          : "All crawled pages have unique title tags.",
      rawData: { duplicateTitleGroups: duplicateTitleCount, pagesChecked: pageTitles.length },
      confidence: 0.95,
      recommendationText:
        duplicateTitleCount > 0 ? "Give each page a unique, descriptive title tag." : null,
    });

    draftEvidence.push(
      {
        url: null,
        category: "technical_seo",
        source: "robots_txt",
        severity: robots.fetched ? "info" : "minor",
        finding: robots.fetched
          ? "robots.txt is present and does not block crawling entirely."
          : "No robots.txt file was found.",
        rawData: { present: robots.fetched },
        confidence: 1,
        recommendationText: robots.fetched ? null : "Add a robots.txt file at the site root.",
      },
      {
        url: null,
        category: "technical_seo",
        source: "sitemap_xml",
        severity: sitemapFound ? "info" : "minor",
        finding: sitemapFound
          ? "sitemap.xml was found at the site root."
          : "No sitemap.xml was found at the site root.",
        rawData: { present: sitemapFound },
        confidence: 1,
        recommendationText: sitemapFound
          ? null
          : "Publish an XML sitemap and reference it from robots.txt.",
      }
    );

    // Site-level: WordPress detection + security headers, evaluated from the homepage response.
    let isWordPress = false;
    if (homepageHtml) {
      const wp = detectWordPress(homepageHtml);
      isWordPress = wp.isWordPress;
      if (wp.isWordPress) {
        draftEvidence.push({
          url: rootUrl,
          category: "wordpress_maintainability",
          source: "wp_version_disclosed",
          severity: wp.version ? "minor" : "info",
          finding: wp.version
            ? `WordPress core version ${wp.version} is publicly disclosed via the generator meta tag.`
            : "WordPress was detected but the core version is not publicly disclosed.",
          rawData: { version: wp.version },
          confidence: 0.9,
          recommendationText: wp.version
            ? "Remove the generator meta tag to avoid advertising the exact core version to attackers."
            : null,
        });
        const plugins = detectPluginSlugs(homepageHtml);
        draftEvidence.push({
          url: rootUrl,
          category: "wordpress_maintainability",
          source: "plugin_inventory",
          severity: "info",
          finding: `${plugins.length} plugin(s) detectable from public page markup.`,
          rawData: { plugins },
          confidence: 0.75,
          recommendationText: null,
        });
      }
    }

    await prisma.client.update({
      where: { id: scan.clientId },
      data: { detectedCms: isWordPress ? "wordpress" : "other" },
    });

    if (homepageHtml) {
      // Homepage-scoped security header checks (cheap, high-signal — not repeated per page).
      draftEvidence.push(...buildSecurityHeaderEvidence(rootUrl, homepageHeaders));
    }

    const createdEvidence = await prisma.evidenceItem.createManyAndReturn({
      data: draftEvidence.map((item) => ({
        scanId,
        category: item.category,
        source: item.source,
        severity: item.severity,
        finding: item.finding,
        url: item.url,
        rawData: (item.rawData as Prisma.InputJsonValue) ?? undefined,
        confidence: item.confidence,
      })),
    });
    // createManyAndReturn preserves input order, so this zips each persisted row back up
    // with the recommendation text that isn't stored on EvidenceItem itself.
    const evidenceWithRecommendation = createdEvidence.map((row, i) => ({
      ...row,
      recommendationText: draftEvidence[i].recommendationText,
    }));

    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "scoring", pagesCrawled: crawledCount },
    });

    await scoreAndFinalize(scanId, isWordPress, rootUrl, evidenceWithRecommendation);
  } catch (error) {
    await prisma.scan.update({
      where: { id: scanId },
      data: {
        status: "failed",
        completedAt: new Date(),
        failureReason: error instanceof Error ? error.message : "Unknown error during scan",
      },
    });
  }
}

function buildPageEvidence(url: string, html: string): DraftEvidence[] {
  const items: DraftEvidence[] = [];
  const title = extractTitle(html);
  const description = extractMetaContent(html, "description");
  const canonical = extractCanonical(html);
  const h1Count = extractH1Count(html);
  const { total: imgTotal, withAlt: imgWithAlt } = extractImgAltCoverage(html);
  const isHttps = new URL(url).protocol === "https:";
  const titleOk = title !== null && title.length >= 10 && title.length <= 60;
  const descriptionOk = description !== null && description.length <= 160;
  const imagesOk = imgTotal === 0 || imgWithAlt === imgTotal;
  const hasLang = hasHtmlLangAttr(html);
  const hasStructuredData = hasJsonLd(html);
  const hasViewport = hasViewportMeta(html);
  const hasFavicon = extractFaviconPresence(html);
  const hasAnalytics = hasAnalyticsTag(html);
  const hasContact = hasContactAffordance(html);

  items.push(
    {
      url,
      category: "on_page_seo",
      source: "title_tag",
      severity: !title ? "major" : titleOk ? "info" : "minor",
      finding: title ? `Title tag: "${title}"` : "No <title> tag found.",
      rawData: { length: title?.length ?? 0 },
      confidence: 0.95,
      recommendationText: !title
        ? "Add a descriptive title tag (roughly 10-60 characters)."
        : !titleOk
          ? "Adjust the title length to roughly 10-60 characters."
          : null,
    },
    {
      url,
      category: "on_page_seo",
      source: "meta_description",
      severity: !description ? "moderate" : descriptionOk ? "info" : "minor",
      finding: description ? `Meta description: "${description}"` : "No meta description found.",
      rawData: { length: description?.length ?? 0 },
      confidence: 0.95,
      recommendationText: !description
        ? "Add a meta description summarizing the page in ~150-160 characters."
        : !descriptionOk
          ? "Shorten the meta description to avoid truncation in search results."
          : null,
    },
    {
      url,
      category: "on_page_seo",
      source: "h1_heading",
      severity: h1Count === 1 ? "info" : "minor",
      finding: `Page has ${h1Count} <h1> tag(s).`,
      rawData: { h1Count },
      confidence: 0.95,
      recommendationText:
        h1Count === 1 ? null : "Use exactly one <h1> per page for a clear content hierarchy.",
    },
    {
      url,
      category: "technical_seo",
      source: "canonical_tag",
      severity: canonical ? "info" : "minor",
      finding: canonical ? `Canonical URL: ${canonical}` : "No canonical tag found.",
      rawData: { canonical },
      confidence: 0.95,
      recommendationText: canonical
        ? null
        : "Add a self-referencing canonical tag to avoid duplicate content ambiguity.",
    },
    {
      url,
      category: "security",
      source: "https_enforced",
      severity: isHttps ? "info" : "critical",
      finding: isHttps ? "Page is served over HTTPS." : "Page is served over plain HTTP.",
      rawData: { scheme: new URL(url).protocol },
      confidence: 1,
      recommendationText: isHttps
        ? null
        : "Serve all pages over HTTPS and redirect HTTP to HTTPS.",
    },
    {
      url,
      category: "accessibility",
      source: "image_alt_text",
      severity: imagesOk ? "info" : "moderate",
      finding: `${imgWithAlt} of ${imgTotal} images on this page have alt text.`,
      rawData: { total: imgTotal, withAlt: imgWithAlt },
      confidence: 0.9,
      recommendationText:
        imgTotal > 0 && !imagesOk ? "Add descriptive alt text to all meaningful images." : null,
    },
    {
      url,
      category: "accessibility",
      source: "html_lang_attribute",
      severity: hasLang ? "info" : "minor",
      finding: hasLang
        ? "The <html> tag declares a lang attribute."
        : "The <html> tag is missing a lang attribute.",
      rawData: { present: hasLang },
      confidence: 0.95,
      recommendationText: hasLang ? null : "Add a lang attribute to the <html> tag.",
    },
    {
      url,
      category: "ai_discoverability",
      source: "structured_data",
      severity: hasStructuredData ? "info" : "moderate",
      finding: hasStructuredData
        ? "Page includes JSON-LD structured data."
        : "No JSON-LD structured data was found.",
      rawData: { present: hasStructuredData },
      confidence: 0.9,
      recommendationText: hasStructuredData
        ? null
        : "Add schema.org JSON-LD so AI crawlers and search engines can parse entities reliably.",
    },
    {
      url,
      category: "brand_experience",
      source: "mobile_viewport",
      severity: hasViewport ? "info" : "moderate",
      finding: hasViewport
        ? "Page declares a responsive viewport meta tag."
        : "No responsive viewport meta tag was found.",
      rawData: { present: hasViewport },
      confidence: 0.95,
      recommendationText: hasViewport
        ? null
        : "Add a viewport meta tag so the page renders correctly on mobile devices.",
    },
    {
      url,
      category: "brand_experience",
      source: "favicon",
      severity: hasFavicon ? "info" : "minor",
      finding: hasFavicon ? "Page declares a favicon." : "No favicon link tag was found.",
      rawData: { present: hasFavicon },
      confidence: 0.9,
      recommendationText: hasFavicon
        ? null
        : "Add a favicon for brand consistency in browser tabs.",
    },
    {
      url,
      category: "analytics",
      source: "analytics_tag",
      severity: hasAnalytics ? "info" : "moderate",
      finding: hasAnalytics
        ? "A recognizable analytics/tag-manager snippet was detected."
        : "No recognizable analytics or tag-manager snippet was detected.",
      rawData: { present: hasAnalytics },
      confidence: 0.85,
      recommendationText: hasAnalytics
        ? null
        : "Install GA4 or a tag manager so traffic and conversions can be measured.",
    },
    {
      url,
      category: "conversion",
      source: "contact_affordance",
      severity: hasContact ? "info" : "minor",
      finding: hasContact
        ? "Page includes a form, mailto:, or tel: contact affordance."
        : "No form, mailto:, or tel: contact affordance found on this page.",
      rawData: { present: hasContact },
      confidence: 0.9,
      recommendationText: hasContact
        ? null
        : "Add a clear call-to-action or contact method on this page.",
    }
  );

  return items;
}

function buildSecurityHeaderEvidence(
  pageUrl: string,
  headers: Record<string, string>
): DraftEvidence[] {
  const hasHsts = Boolean(headers["strict-transport-security"]);
  const hasCsp = Boolean(headers["content-security-policy"]);
  const hasXfo =
    Boolean(headers["x-frame-options"]) ||
    /frame-ancestors/i.test(headers["content-security-policy"] ?? "");

  return [
    {
      url: pageUrl,
      category: "security",
      source: "hsts_header",
      severity: hasHsts ? "info" : "moderate",
      finding: hasHsts
        ? "Strict-Transport-Security header is present."
        : "Strict-Transport-Security header is missing.",
      rawData: { present: hasHsts },
      confidence: 1,
      recommendationText: hasHsts
        ? null
        : "Add a Strict-Transport-Security header to enforce HTTPS in the browser.",
    },
    {
      url: pageUrl,
      category: "security",
      source: "content_security_policy",
      severity: hasCsp ? "info" : "minor",
      finding: hasCsp
        ? "Content-Security-Policy header is present."
        : "Content-Security-Policy header is missing.",
      rawData: { present: hasCsp },
      confidence: 1,
      recommendationText: hasCsp ? null : "Add a Content-Security-Policy header to reduce XSS exposure.",
    },
    {
      url: pageUrl,
      category: "security",
      source: "clickjacking_protection",
      severity: hasXfo ? "info" : "minor",
      finding: hasXfo
        ? "X-Frame-Options or frame-ancestors protection is present."
        : "No clickjacking protection (X-Frame-Options / frame-ancestors) was found.",
      rawData: { present: hasXfo },
      confidence: 1,
      recommendationText: hasXfo ? null : "Add X-Frame-Options or a CSP frame-ancestors directive.",
    },
  ];
}

type EvidenceWithRecommendation = Awaited<
  ReturnType<typeof prisma.evidenceItem.createManyAndReturn>
>[number] & { recommendationText: string | null };

async function scoreAndFinalize(
  scanId: string,
  isWordPress: boolean,
  rootUrl: string,
  evidenceItems: EvidenceWithRecommendation[]
): Promise<void> {
  const categories = [...new Set(evidenceItems.map((e) => e.category))] as EvidenceCategory[];
  const categoryScoreMap: Partial<Record<EvidenceCategory, number>> = {};
  const categorySummaries: { category: EvidenceCategory; score: number; rationale: string }[] = [];

  for (const category of categories) {
    const categoryEvidence = evidenceItems.filter((e) => e.category === category);
    const score = computeCategoryScore(categoryEvidence);
    categoryScoreMap[category] = score;

    const failing = categoryEvidence.filter((e) => !isPassing(e.severity));
    const rationale =
      failing.length === 0
        ? `All ${categoryEvidence.length} checks passed.`
        : `${failing.length} of ${categoryEvidence.length} checks need attention.`;
    categorySummaries.push({ category, score, rationale });

    const avgConfidence =
      categoryEvidence.reduce((sum, e) => sum + e.confidence, 0) / categoryEvidence.length;

    await prisma.categoryScore.create({
      data: {
        scanId,
        category,
        score,
        maxScore: 100,
        status: statusFromScore(score),
        rationale,
        confidence: Math.round(avgConfidence * 100) / 100,
        evidenceRefs: categoryEvidence.map((e) => e.id),
      },
    });
  }

  const overallScore = computeOverallScore(
    categories.map((category) => ({ category, score: categoryScoreMap[category]! })),
    isWordPress
  );
  const grade = gradeFromScore(overallScore);
  const businessRisk = deriveBusinessRisk(evidenceItems, categoryScoreMap);
  const aiReadiness = deriveAiReadiness(categoryScoreMap);

  const failingByCheck = new Map<string, (typeof evidenceItems)[number]>();
  for (const item of evidenceItems) {
    if (isPassing(item.severity)) continue;
    const key = `${item.category}:${item.source}`;
    const existing = failingByCheck.get(key);
    if (!existing || severityRank(item.severity) > severityRank(existing.severity)) {
      failingByCheck.set(key, item);
    }
  }
  const worstFindings = [...failingByCheck.values()]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 8);

  const recommendationTexts = worstFindings
    .map((f) => f.recommendationText)
    .filter((r): r is string => Boolean(r))
    .slice(0, 6);

  const methodologyNote = isWordPress
    ? "Scored across all 10 WII categories, including WordPress maintainability."
    : "WordPress maintainability was not applicable for this site; its weight was redistributed across the other 9 categories.";
  const executiveSummary = buildExecutiveSummary(rootUrl, overallScore, grade, businessRisk);

  const roadmap = worstFindings.map((finding, index) => ({
    priorityRank: index + 1,
    title: finding.source.replace(/_/g, " "),
    category: finding.category,
    impact: severityRank(finding.severity) >= 4 ? "High" : severityRank(finding.severity) >= 3 ? "Medium" : "Low",
    effort: estimateEffort(finding.category, finding.source),
    recommendation: finding.recommendationText ?? finding.finding,
  }));

  const fullReport = {
    rootUrl,
    overallScore,
    grade,
    businessRisk,
    aiReadiness,
    methodologyNote,
    categoryScores: categorySummaries,
    roadmap,
    recommendations: recommendationTexts,
    generatedAt: new Date().toISOString(),
  };

  await prisma.report.create({
    data: {
      scanId,
      executiveSummary,
      fullReport,
      html: buildReportHtml(fullReport),
      pdfUrl: null,
    },
  });

  await prisma.recommendation.createMany({
    data: worstFindings.map((finding, index) => ({
      scanId,
      priorityRank: index + 1,
      title: finding.source.replace(/_/g, " "),
      category: finding.category,
      impact: severityRank(finding.severity) >= 4 ? "High" : severityRank(finding.severity) >= 3 ? "Medium" : "Low",
      effort: estimateEffort(finding.category, finding.source),
      recommendation: finding.recommendationText ?? finding.finding,
      evidenceRefs: [finding.id],
    })),
  });

  await prisma.scan.update({
    where: { id: scanId },
    data: { status: "complete", completedAt: new Date() },
  });
}

function severityRank(severity: Severity): number {
  return { info: 0, minor: 1, moderate: 2, major: 3, critical: 4 }[severity];
}

function estimateEffort(category: EvidenceCategory, source: string): "Low" | "Medium" | "High" {
  if (source.includes("header") || source.includes("meta") || source.includes("title")) return "Low";
  if (category === "wordpress_maintainability" || category === "performance") return "Medium";
  return "Low";
}

function buildExecutiveSummary(
  rootUrl: string,
  overallScore: number,
  grade: string,
  businessRisk: string
): string {
  return (
    `${rootUrl} scored ${overallScore}/100 (Grade ${grade}) on the Website Intelligence Index. ` +
    `Overall business risk from this scan is ${businessRisk}. ` +
    `See the category breakdown and evidence below for the specific findings driving this score, ` +
    `and the priority roadmap for the highest-impact next steps.`
  );
}
