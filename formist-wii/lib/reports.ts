import { prisma } from "@/lib/prisma";
import { computeOverallScore, gradeFromScore } from "@/lib/scoring";
import type { ReportData } from "@/lib/report-service";

/**
 * Overall score/grade are derived from CategoryScore rows, not a stored column — see
 * lib/scoring.ts. Each row's `score` is already "out of its (possibly WordPress-redistributed)
 * maxScore" as of write time (lib/scan-pipeline.ts), so summing raw scores here is enough; no
 * per-category weighting needs to happen again at read time. Used by the dashboard's scan list,
 * which only needs the headline number/grade and doesn't load a full report.
 */
export function computeScoreSummary(categoryScores: { score: number }[]) {
  const overallScore = computeOverallScore(categoryScores);
  const grade = gradeFromScore(overallScore);
  return { overallScore, grade };
}

export async function getReportPayload(id: string) {
  const report = await prisma.report.findUnique({ where: { id } });
  if (!report) return null;

  return {
    id: report.id,
    scanId: report.scanId,
    pdfUrl: report.pdfUrl,
    status: report.status,
    reviewedBy: report.reviewedBy,
    reviewedAt: report.reviewedAt,
    data: report.fullReport as unknown as ReportData,
  };
}

export type ReportPayload = NonNullable<Awaited<ReturnType<typeof getReportPayload>>>;
