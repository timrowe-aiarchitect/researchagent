import { prisma } from "@/lib/prisma";
import { crawlWebsite, normalizeDomain } from "@/lib/crawler-service";
import { extractAllEvidenceForPage, type ScanContext } from "@/lib/extractors";
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
import type { EvidenceCategory, Severity } from "@/generated/prisma/enums";

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

    const scanContext: ScanContext = {
      scanId,
      rootUrl,
      homepageUrl: rootUrl,
      robotsFound: crawl.robotsFound,
      robotsTxtContent: crawl.robotsTxtContent,
      sitemapFound: crawl.sitemapFound,
      llmsTxtFound: crawl.llmsTxtFound,
      allPages: crawl.pages,
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
