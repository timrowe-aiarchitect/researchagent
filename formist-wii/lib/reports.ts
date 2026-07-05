import { prisma } from "@/lib/prisma";
import {
  CATEGORY_LABELS,
  computeOverallScore,
  derivePriority,
  gradeFromScore,
  deriveAiReadiness,
  deriveBusinessRisk,
} from "@/lib/scoring";
import type { EvidenceCategory } from "@/generated/prisma/enums";

/**
 * Overall score/grade are derived from CategoryScore rows, not a stored column — see
 * lib/scoring.ts. Each row's `score` is already "out of its (possibly WordPress-redistributed)
 * maxScore" as of write time (lib/scan-pipeline.ts), so summing raw scores here is enough; no
 * per-category weighting needs to happen again at read time.
 */
export function computeScoreSummary(categoryScores: { score: number }[]) {
  const overallScore = computeOverallScore(categoryScores);
  const grade = gradeFromScore(overallScore);
  return { overallScore, grade };
}

export async function getReportPayload(id: string) {
  const report = await prisma.report.findUnique({
    where: { id },
    include: {
      scan: {
        include: {
          client: true,
          categoryScores: true,
          evidenceItems: true,
          recommendations: { orderBy: { priorityRank: "asc" } },
          pages: true,
        },
      },
    },
  });

  if (!report) return null;

  const { scan } = report;
  const isWordPress = scan.client.detectedCms === "wordpress";

  const evidenceByCategory = new Map<
    EvidenceCategory,
    ReturnType<typeof serializeEvidence>[]
  >();
  for (const item of scan.evidenceItems) {
    const list = evidenceByCategory.get(item.category) ?? [];
    list.push(serializeEvidence(item));
    evidenceByCategory.set(item.category, list);
  }

  // Ratios (0-1), not raw points, since categories now have different maxScore allocations —
  // deriveBusinessRisk/deriveAiReadiness compare against fixed ratio thresholds.
  const categoryRatioMap: Partial<Record<EvidenceCategory, number>> = {};
  for (const cs of scan.categoryScores) {
    categoryRatioMap[cs.category] = cs.maxScore > 0 ? cs.score / cs.maxScore : 0;
  }

  const { overallScore, grade } = computeScoreSummary(
    scan.categoryScores.map((cs) => ({ score: cs.score }))
  );
  const businessRisk = deriveBusinessRisk(scan.evidenceItems, categoryRatioMap);
  const aiReadiness = deriveAiReadiness(categoryRatioMap).score;
  const priority = derivePriority(overallScore, businessRisk);
  const methodologyNote = isWordPress
    ? "Scored across all 10 WII categories, including WordPress maintainability."
    : "WordPress maintainability was not applicable for this site; its points were redistributed across the other 9 categories.";

  const categoryScores = [...scan.categoryScores]
    .sort((a, b) => (categoryRatioMap[b.category] ?? 0) - (categoryRatioMap[a.category] ?? 0))
    .map((cs) => ({
      category: cs.category,
      label: CATEGORY_LABELS[cs.category],
      score: cs.score,
      maxScore: cs.maxScore,
      status: cs.status,
      rationale: cs.rationale,
      confidence: cs.confidence,
      evidence: evidenceByCategory.get(cs.category) ?? [],
    }));

  return {
    id: report.id,
    scanId: report.scanId,
    client: {
      id: scan.client.id,
      name: scan.client.name,
      rootUrl: scan.client.rootUrl,
      detectedCms: scan.client.detectedCms,
    },
    pagesCrawled: scan.pagesCrawled,
    overallScore,
    grade,
    businessRisk,
    aiReadiness,
    priority,
    executiveSummary: report.executiveSummary,
    methodologyNote,
    recommendations: scan.recommendations
      .map((r) => r.recommendation)
      .filter((r, i, arr) => arr.indexOf(r) === i)
      .slice(0, 6),
    categoryScores,
    roadmap: scan.recommendations.map((item) => ({
      priorityRank: item.priorityRank,
      title: item.title,
      category: item.category,
      categoryLabel: CATEGORY_LABELS[item.category],
      impact: item.impact,
      effort: item.effort,
      recommendation: item.recommendation,
    })),
    pages: scan.pages.map((p) => ({
      url: p.url,
      httpStatus: p.httpStatus,
      crawlStatus: p.crawlStatus,
    })),
    generatedAt: report.generatedAt,
    pdfUrl: report.pdfUrl,
    html: report.html,
  };
}

export type ReportPayload = NonNullable<Awaited<ReturnType<typeof getReportPayload>>>;

function serializeEvidence(item: {
  id: string;
  source: string;
  severity: string;
  finding: string;
  url: string | null;
  confidence: number;
}) {
  return {
    id: item.id,
    source: item.source,
    severity: item.severity,
    finding: item.finding,
    pageUrl: item.url,
    confidence: item.confidence,
  };
}
