import { prisma } from "@/lib/prisma";
import {
  CATEGORY_LABELS,
  computeOverallScore,
  gradeFromScore,
  deriveAiReadiness,
  deriveBusinessRisk,
} from "@/lib/scoring";
import type { EvidenceCategory } from "@/generated/prisma/enums";

/** Overall score/grade are derived from CategoryScore rows, not stored columns — see lib/scoring.ts §8. */
export function computeScoreSummary(
  categoryScores: { category: EvidenceCategory; score: number }[],
  isWordPress: boolean
) {
  const overallScore = computeOverallScore(categoryScores, isWordPress);
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

  const categoryScoreMap: Partial<Record<EvidenceCategory, number>> = {};
  for (const cs of scan.categoryScores) categoryScoreMap[cs.category] = cs.score;

  const { overallScore, grade } = computeScoreSummary(
    scan.categoryScores.map((cs) => ({ category: cs.category, score: cs.score })),
    isWordPress
  );
  const businessRisk = deriveBusinessRisk(scan.evidenceItems, categoryScoreMap);
  const aiReadiness = deriveAiReadiness(categoryScoreMap);
  const methodologyNote = isWordPress
    ? "Scored across all 10 WII categories, including WordPress maintainability."
    : "WordPress maintainability was not applicable for this site; its weight was redistributed across the other 9 categories.";

  const categoryScores = [...scan.categoryScores]
    .sort((a, b) => b.score - a.score)
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
