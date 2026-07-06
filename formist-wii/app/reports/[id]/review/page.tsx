import { notFound } from "next/navigation";

import { getReportPayload } from "@/lib/reports";
import { ReportSubNav } from "@/components/report-sub-nav";
import { ReportStatusControls } from "@/components/report-status-controls";
import { CategoryReviewForm, type CategoryReviewData } from "@/components/category-review-form";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const report = await getReportPayload(id);
  if (!report) notFound();

  const { data } = report;
  const locked = report.status === "exported";

  const reviewable: CategoryReviewData[] = [
    ...data.categoryDeepDives.map((cs) => ({
      category: cs.category,
      label: cs.label,
      maxScore: cs.maxScore,
      score: cs.score,
      rationale: cs.rationale,
      automatedScore: cs.automatedScore,
      automatedRationale: cs.automatedRationale,
      isOverridden: cs.isOverridden,
      overrideNote: cs.overrideNote,
      overriddenBy: cs.overriddenBy,
      overriddenAt: cs.overriddenAt,
    })),
    {
      category: "ai_discoverability",
      label: "AI Discoverability",
      maxScore: data.aiDiscoverabilityAssessment.maxScore,
      score: data.aiDiscoverabilityAssessment.score,
      rationale: data.aiDiscoverabilityAssessment.rationale,
      automatedScore: data.aiDiscoverabilityAssessment.automatedScore,
      automatedRationale: data.aiDiscoverabilityAssessment.automatedRationale,
      isOverridden: data.aiDiscoverabilityAssessment.isOverridden,
      overrideNote: data.aiDiscoverabilityAssessment.overrideNote,
      overriddenBy: data.aiDiscoverabilityAssessment.overriddenBy,
      overriddenAt: data.aiDiscoverabilityAssessment.overriddenAt,
    },
    ...(data.wordpressMaintainabilityAssessment.applicable
      ? [
          {
            category: "wordpress_maintainability",
            label: "WordPress Maintainability",
            maxScore: data.wordpressMaintainabilityAssessment.maxScore,
            score: data.wordpressMaintainabilityAssessment.score,
            rationale: data.wordpressMaintainabilityAssessment.rationale,
            automatedScore: data.wordpressMaintainabilityAssessment.automatedScore,
            automatedRationale: data.wordpressMaintainabilityAssessment.automatedRationale,
            isOverridden: data.wordpressMaintainabilityAssessment.isOverridden,
            overrideNote: data.wordpressMaintainabilityAssessment.overrideNote,
            overriddenBy: data.wordpressMaintainabilityAssessment.overriddenBy,
            overriddenAt: data.wordpressMaintainabilityAssessment.overriddenAt,
          },
        ]
      : []),
  ].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <ReportSubNav reportId={id} active="review" />

      <div>
        <p className="text-muted-foreground text-sm font-medium">Review</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight break-all">
          {data.cover.clientName ?? data.cover.rootUrl}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Edit a category&apos;s rationale or override its score before this report is marked final. Every
          score override requires a note.
        </p>
      </div>

      <div className="mt-6">
        <ReportStatusControls reportId={report.id} status={report.status} />
      </div>

      <div className="mt-8 flex flex-col gap-4">
        {reviewable.map((item) => (
          <CategoryReviewForm key={item.category} reportId={report.id} data={item} locked={locked} />
        ))}
      </div>
    </div>
  );
}
