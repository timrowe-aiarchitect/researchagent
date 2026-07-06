import { prisma } from "@/lib/prisma";
import { buildReportHtml } from "@/lib/report-html";
import {
  DEDICATED_SECTION_CATEGORIES,
  generateReportPdf,
  type ReportCategorySummary,
  type ReportData,
} from "@/lib/report-service";
import { CATEGORY_LABELS, computeScanScoreFromCategoryScores, statusFromRatio } from "@/lib/scoring";
import type { EvidenceCategory, ReportStatus } from "@/generated/prisma/enums";

/**
 * The human review workflow: a Formist reviewer can edit a category's rationale and/or override
 * its score before a report is marked final. Automated fields on CategoryScore (score, status,
 * rationale) are written once by the scoring engine and never mutated — this module only ever
 * writes the override_* columns, so the automated result is always recoverable. Every score
 * override requires a note (validated below); editing only the rationale does not.
 *
 * updateCategoryReview() patches the single affected category directly in the already-built
 * Report.fullReport (rather than rebuilding the whole report from scratch) and re-derives the
 * overall score/grade/businessRisk/aiReadiness/priority from every category's current effective
 * score — the narrative-authored prose (executive summary, top risks/opportunities, roadmap
 * narrative, recommended next steps) is untouched, since none of that is affected by a single
 * category's score or rationale changing.
 */

const ALLOWED_STATUS_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  draft: ["needs_review"],
  needs_review: ["draft", "approved"],
  approved: ["needs_review", "exported"],
  exported: [],
};

// Once exported, a report is locked — no further category edits or status changes are allowed.
const EDITABLE_STATUSES: ReportStatus[] = ["draft", "needs_review", "approved"];

export type CategoryReviewInput = {
  reportId: string;
  category: EvidenceCategory;
  rationale: string;
  score: number;
  note: string | null;
  reviewerName: string;
};

export type CategoryReviewResult =
  | { ok: true; summary: ReportCategorySummary }
  | { ok: false; error: string };

function patchCategoryBreakdown(
  data: ReportData,
  category: EvidenceCategory,
  patch: { score: number; status: ReportData["overallIndex"]["categoryBreakdown"][number]["status"]; isOverridden: boolean }
): ReportData["overallIndex"]["categoryBreakdown"] {
  return data.overallIndex.categoryBreakdown
    .map((c) => (c.category === category ? { ...c, ...patch } : c))
    .sort((a, b) => b.score / b.maxScore - a.score / a.maxScore);
}

export async function updateCategoryReview(input: CategoryReviewInput): Promise<CategoryReviewResult> {
  const report = await prisma.report.findUnique({ where: { id: input.reportId } });
  if (!report) {
    return { ok: false, error: "Report not found." };
  }
  if (!EDITABLE_STATUSES.includes(report.status)) {
    return { ok: false, error: `Cannot edit a report once it has been ${report.status}.` };
  }

  const scoreRow = await prisma.categoryScore.findFirst({
    where: { scanId: report.scanId, category: input.category },
  });
  if (!scoreRow) {
    return { ok: false, error: `This scan has no ${CATEGORY_LABELS[input.category]} score to review.` };
  }

  if (!Number.isFinite(input.score) || input.score < 0 || input.score > scoreRow.maxScore) {
    return { ok: false, error: `Score must be between 0 and ${scoreRow.maxScore}.` };
  }

  const scoreChanged = input.score !== scoreRow.score;
  const rationaleChanged = input.rationale.trim() !== scoreRow.rationale.trim();

  if (scoreChanged && !input.note?.trim()) {
    return { ok: false, error: "A note is required whenever you override a score." };
  }

  const overrideScore = scoreChanged ? input.score : null;
  const overrideRationale = rationaleChanged ? input.rationale.trim() : null;
  const isOverridden = overrideScore !== null || overrideRationale !== null;

  const updated = await prisma.categoryScore.update({
    where: { id: scoreRow.id },
    data: {
      overrideScore,
      overrideRationale,
      overrideNote: isOverridden ? input.note?.trim() || null : null,
      overriddenBy: isOverridden ? input.reviewerName : null,
      overriddenAt: isOverridden ? new Date() : null,
    },
  });

  // Re-derive the overall figures from every category's current effective score, plus the raw,
  // unedited evidence (a score override can't suppress a real critical finding's risk signal —
  // see computeScanScoreFromCategoryScores).
  const [allScores, allEvidence] = await Promise.all([
    prisma.categoryScore.findMany({ where: { scanId: report.scanId } }),
    prisma.evidenceItem.findMany({ where: { scanId: report.scanId }, select: { category: true, severity: true } }),
  ]);
  const final = computeScanScoreFromCategoryScores({
    categoryScores: allScores.map((cs) => ({
      category: cs.category,
      score: cs.overrideScore ?? cs.score,
      maxScore: cs.maxScore,
    })),
    evidence: allEvidence,
  });

  const effectiveScore = updated.overrideScore ?? updated.score;
  const effectiveStatus =
    updated.maxScore > 0 ? statusFromRatio(effectiveScore / updated.maxScore) : updated.status;
  const effectiveRationale = updated.overrideRationale ?? updated.rationale;

  const summary: ReportCategorySummary = {
    category: updated.category,
    label: CATEGORY_LABELS[updated.category],
    maxScore: updated.maxScore,
    confidence: updated.confidence,
    evidence: [],
    score: effectiveScore,
    status: effectiveStatus,
    rationale: effectiveRationale,
    automatedScore: updated.score,
    automatedStatus: updated.status,
    automatedRationale: updated.rationale,
    isOverridden,
    overrideNote: updated.overrideNote,
    overriddenBy: updated.overriddenBy,
    overriddenAt: updated.overriddenAt?.toISOString() ?? null,
  };

  const data = report.fullReport as unknown as ReportData;
  const breakdownPatch = { score: effectiveScore, status: effectiveStatus, isOverridden: summary.isOverridden };

  const patched: ReportData = {
    ...data,
    cover: { ...data.cover, overallScore: final.overallScore, grade: final.grade },
    executiveScorecard: {
      ...data.executiveScorecard,
      overallScore: final.overallScore,
      grade: final.grade,
      businessRisk: final.businessRisk,
      aiReadiness: final.aiReadiness,
      priority: final.priority,
    },
    overallIndex: {
      ...data.overallIndex,
      overallScore: final.overallScore,
      grade: final.grade,
      categoryBreakdown: patchCategoryBreakdown(data, updated.category, breakdownPatch),
    },
    categoryDeepDives: DEDICATED_SECTION_CATEGORIES.includes(updated.category)
      ? data.categoryDeepDives
      : data.categoryDeepDives
          .map((cs) => (cs.category === updated.category ? { ...cs, ...summary, evidence: cs.evidence } : cs))
          .sort((a, b) => b.score / b.maxScore - a.score / a.maxScore),
    aiDiscoverabilityAssessment:
      updated.category === "ai_discoverability"
        ? { ...data.aiDiscoverabilityAssessment, ...summary, evidence: data.aiDiscoverabilityAssessment.evidence }
        : data.aiDiscoverabilityAssessment,
    wordpressMaintainabilityAssessment:
      updated.category === "wordpress_maintainability" && data.wordpressMaintainabilityAssessment.applicable
        ? { ...data.wordpressMaintainabilityAssessment, ...summary, evidence: data.wordpressMaintainabilityAssessment.evidence }
        : data.wordpressMaintainabilityAssessment,
  };

  const html = buildReportHtml(patched);
  await prisma.report.update({
    where: { id: report.id },
    data: { fullReport: patched as object, html },
  });

  // Return the summary with its real evidence list (dropped above since we never re-fetched
  // EvidenceItem rows — patchCategoryBreakdown/categoryDeepDives above preserve it from the
  // existing stored report, only the caller-facing return value needs it filled in).
  const storedSummary =
    updated.category === "ai_discoverability"
      ? patched.aiDiscoverabilityAssessment
      : updated.category === "wordpress_maintainability" && patched.wordpressMaintainabilityAssessment.applicable
        ? patched.wordpressMaintainabilityAssessment
        : patched.categoryDeepDives.find((cs) => cs.category === updated.category);

  return { ok: true, summary: { ...summary, evidence: storedSummary?.evidence ?? [] } };
}

export type StatusUpdateInput = {
  reportId: string;
  status: ReportStatus;
  reviewerName: string;
};

export type StatusUpdateResult = { ok: true; status: ReportStatus } | { ok: false; error: string };

/**
 * Transitions Report.status through draft -> needs_review -> approved -> exported (with
 * needs_review/approved allowing a step back for further edits). Regenerates the PDF whenever the
 * report enters approved or exported, so the exported deliverable reflects any reviewer overrides
 * applied since the last render — draft/needs_review edits only rebuild the (fast) HTML, not the
 * (slower) PDF, so iterative reviewing stays quick.
 */
export async function updateReportStatus(input: StatusUpdateInput): Promise<StatusUpdateResult> {
  const report = await prisma.report.findUnique({ where: { id: input.reportId } });
  if (!report) return { ok: false, error: "Report not found." };

  const allowed = ALLOWED_STATUS_TRANSITIONS[report.status];
  if (!allowed.includes(input.status)) {
    return { ok: false, error: `Cannot move a report from ${report.status} to ${input.status}.` };
  }

  let pdfUrl = report.pdfUrl;
  if (input.status === "approved" || input.status === "exported") {
    const data = report.fullReport as unknown as ReportData;
    const html = buildReportHtml(data);
    pdfUrl = await generateReportPdf(html, report.scanId);
  }

  await prisma.report.update({
    where: { id: report.id },
    data: { status: input.status, reviewedBy: input.reviewerName, reviewedAt: new Date(), pdfUrl },
  });

  return { ok: true, status: input.status };
}
