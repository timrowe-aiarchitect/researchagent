import { prisma } from "@/lib/prisma";
import { crawlWebsite, normalizeDomain } from "@/lib/crawler-service";
import { extractAllEvidenceForPage, type ScanContext } from "@/lib/extractors";
import { isCrawlOk } from "@/lib/extractors/types";
import { fetchPageSpeedForPages, PSI_MAX_PRIORITY_PAGES } from "@/lib/pagespeed-service";
import { computeScanScore, isPassing } from "@/lib/scoring";
import { generateQualitativeAssessment } from "@/lib/qualitative-assessment";
import { generateReportNarrative } from "@/lib/report-narrative";
import { buildReportData, generateReportPdf } from "@/lib/report-service";
import { buildReportHtml } from "@/lib/report-html";
import type { Prisma } from "@/generated/prisma/client";
import type { CrawlStatus, DetectedCms, EvidenceCategory, Severity } from "@/generated/prisma/enums";

const MAX_SCREENSHOTS_IN_REPORT = 6;

const MAX_PAGES_HARD_CAP = 25;

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
    const rootUrl = normalizeDomain(scan.client.rootUrl);
    const maxPages = Math.min(scan.pagesRequested, MAX_PAGES_HARD_CAP);

    const crawl = await crawlWebsite({ rootUrl, scanId, maxPages });

    if (crawl.blockedByRobots) {
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

    const homepageForPsi = crawl.pages.find((p) => p.requestedUrl === rootUrl) ?? crawl.pages[0];
    // Priority pages, in crawl order, already reflect the crawler's nav/footer/keyword/sitemap
    // tier prioritization (see crawlWebsite() in crawler-service.ts) — so the first
    // PSI_MAX_PRIORITY_PAGES successfully-crawled non-homepage pages are the right sample.
    const priorityPagesForPsi = crawl.pages
      .filter((p) => isCrawlOk(p) && p.requestedUrl !== homepageForPsi?.requestedUrl)
      .slice(0, PSI_MAX_PRIORITY_PAGES);
    const pagesToAnalyzeForPsi = homepageForPsi
      ? [homepageForPsi, ...priorityPagesForPsi]
      : priorityPagesForPsi;

    const pageSpeedResults = await fetchPageSpeedForPages(
      pagesToAnalyzeForPsi.map((p) => p.requestedUrl),
      process.env.PAGESPEED_API_KEY
    );

    const scanContext: ScanContext = {
      scanId,
      rootUrl,
      homepageUrl: rootUrl,
      robotsFound: crawl.robotsFound,
      robotsTxtContent: crawl.robotsTxtContent,
      sitemapFound: crawl.sitemapFound,
      llmsTxtFound: crawl.llmsTxtFound,
      allPages: crawl.pages,
      wordpressDiagnostics: crawl.wordpressDiagnostics,
      pageSpeedResults,
      httpsRedirectCheck: crawl.httpsRedirectCheck,
    };

    const draftEvidence = crawl.pages.flatMap((page) => extractAllEvidenceForPage(scanContext, page));

    const homepage = crawl.pages.find((p) => p.requestedUrl === rootUrl) ?? crawl.pages[0];
    const isWordPress = homepage?.isWordPress ?? false;

    await prisma.client.update({
      where: { id: scan.clientId },
      data: { detectedCms: isWordPress ? "wordpress" : "other" },
    });

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
      data: { status: "scoring", pagesCrawled: crawl.pages.length },
    });

    await scoreAndFinalize(
      scanId,
      isWordPress,
      rootUrl,
      scan.pagesRequested,
      crawl.pages,
      evidenceWithRecommendation,
      { name: scan.client.name, industry: scan.client.industry, conversionGoal: scan.client.conversionGoal }
    );
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

type EvidenceWithRecommendation = Awaited<
  ReturnType<typeof prisma.evidenceItem.createManyAndReturn>
>[number] & { recommendationText: string | null };

async function scoreAndFinalize(
  scanId: string,
  isWordPress: boolean,
  rootUrl: string,
  pagesRequested: number,
  pages: {
    crawlStatus: CrawlStatus;
    requestedUrl: string;
    title: string | null;
    metaDescription: string | null;
    h1: string | null;
    wordCount: number;
    httpStatus: number | null;
    screenshotPath: string | null;
  }[],
  evidenceItems: EvidenceWithRecommendation[],
  clientContext: { name: string | null; industry: string | null; conversionGoal: string | null }
): Promise<void> {
  const scoring = computeScanScore({
    evidence: evidenceItems.map((e) => ({
      id: e.id,
      category: e.category,
      severity: e.severity,
      confidence: e.confidence,
    })),
    pages,
    scanMeta: { pagesRequested, isWordPress },
  });

  for (const cs of scoring.categoryScores) {
    await prisma.categoryScore.create({
      data: {
        scanId,
        category: cs.category,
        score: cs.score,
        maxScore: cs.maxScore,
        status: cs.status,
        rationale: cs.rationale,
        confidence: cs.confidence,
        evidenceRefs: cs.evidenceRefs,
      },
    });
  }

  const { overallScore, grade, businessRisk, aiReadiness, priority } = scoring;

  // Purely additive narrative layer — computed from the same evidence, but never fed back into
  // any score above. Gracefully resolves to null (no API key, network failure, bad response) so
  // it can never fail or alter the scan.
  const qualitativeAssessment = await generateQualitativeAssessment({
    clientName: clientContext.name,
    industry: clientContext.industry,
    conversionGoal: clientContext.conversionGoal,
    pages: pages
      .filter((p) => p.crawlStatus === "success" || p.crawlStatus === "redirect")
      .map((p) => ({
        url: p.requestedUrl,
        title: p.title,
        metaDescription: p.metaDescription,
        h1: p.h1,
        wordCount: p.wordCount,
      })),
    evidence: evidenceItems.map((e) => ({
      category: e.category,
      source: e.source,
      severity: e.severity,
      finding: e.finding,
      confidence: e.confidence,
      url: e.url,
    })),
  });

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

  const roadmap = worstFindings.map((finding, index) => ({
    priorityRank: index + 1,
    title: finding.source.replace(/_/g, " "),
    category: finding.category,
    impact: severityRank(finding.severity) >= 4 ? "High" : severityRank(finding.severity) >= 3 ? "Medium" : "Low",
    effort: estimateEffort(finding.category, finding.source),
    recommendation: finding.recommendationText ?? finding.finding,
  }));

  const screenshots = pages
    .filter((p): p is typeof p & { screenshotPath: string } => Boolean(p.screenshotPath))
    .slice(0, MAX_SCREENSHOTS_IN_REPORT)
    .map((p) => ({ pageUrl: p.requestedUrl, path: p.screenshotPath }));

  // Purely a narrative layer over the already-computed scores/evidence/roadmap below — never
  // alters them. Gracefully resolves to null (no API key, network failure, bad response), in
  // which case buildReportData() falls back to its own deterministic prose for every field.
  const narrative = await generateReportNarrative({
    scan: {
      rootUrl,
      clientName: clientContext.name,
      industry: clientContext.industry,
      conversionGoal: clientContext.conversionGoal,
    },
    overallScore,
    grade,
    businessRisk,
    aiReadiness,
    priority,
    categoryScores: scoring.categoryScores,
    evidenceItems,
    recommendations: roadmap,
  });

  const reportData = buildReportData({
    scan: {
      rootUrl,
      clientName: clientContext.name,
      detectedCms: (isWordPress ? "wordpress" : "other") as DetectedCms,
      pagesRequested,
      pagesCrawled: pages.length,
      generatedAt: new Date(),
      pages: pages.map((p) => ({ url: p.requestedUrl, httpStatus: p.httpStatus, crawlStatus: p.crawlStatus })),
    },
    categoryScores: scoring.categoryScores,
    evidenceItems,
    recommendations: roadmap,
    screenshots,
    overallScore,
    grade,
    businessRisk,
    aiReadiness,
    priority,
    qualitativeAssessment,
    narrative,
  });

  const html = buildReportHtml(reportData);
  const pdfUrl = await generateReportPdf(html, scanId);

  await prisma.report.create({
    data: {
      scanId,
      executiveSummary: reportData.executiveSummary,
      fullReport: reportData as unknown as Prisma.InputJsonValue,
      qualitativeAssessment: (qualitativeAssessment as unknown as Prisma.InputJsonValue) ?? undefined,
      html,
      pdfUrl,
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
