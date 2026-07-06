import { notFound } from "next/navigation";

import { getReportPayload } from "@/lib/reports";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { GradeBadge, RiskBadge, CategoryStatusBadge } from "@/components/status-badges";
import { ExportPdfButton } from "@/components/export-pdf-button";
import { ReportSubNav } from "@/components/report-sub-nav";

export const dynamic = "force-dynamic";

export default async function ScorecardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const report = await getReportPayload(id);
  if (!report) notFound();

  const { data } = report;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <ReportSubNav reportId={id} active="scorecard" />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm font-medium">Scorecard</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight break-all">
            {data.cover.clientName ?? data.cover.rootUrl}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">{data.cover.rootUrl}</p>
        </div>
        <ExportPdfButton pdfUrl={report.pdfUrl} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card className="sm:col-span-1">
          <CardContent className="flex flex-col items-center justify-center gap-2 pt-6 pb-6">
            <div className="flex size-20 items-center justify-center rounded-full border-4 border-primary/20 text-2xl font-bold">
              {data.overallIndex.overallScore}
            </div>
            <GradeBadge grade={data.overallIndex.grade} />
            <span className="text-muted-foreground text-xs">Overall WII score</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              Business risk
              <RiskBadge risk={data.executiveScorecard.businessRisk} />
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              AI readiness
              <Badge variant="secondary">
                {data.executiveScorecard.aiReadiness.score}/100 · {data.executiveScorecard.aiReadiness.label}
              </Badge>
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              Priority
              <RiskBadge risk={data.executiveScorecard.priority} />
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Category scores</h2>
        <Card className="mt-4">
          <CardContent className="flex flex-col gap-5 pt-6 pb-6">
            {data.overallIndex.categoryBreakdown.map((c, i) => (
              <div key={c.category}>
                {i > 0 && <Separator className="mb-5" />}
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{c.label}</span>
                  <div className="flex items-center gap-3">
                    <CategoryStatusBadge status={c.status} />
                    <span className="text-muted-foreground w-14 text-right text-sm">
                      {c.score}/{c.maxScore}
                    </span>
                  </div>
                </div>
                <Progress value={(c.score / c.maxScore) * 100} className="mt-2" />
              </div>
            ))}
          </CardContent>
        </Card>
        <CardDescription className="mt-3 text-xs">{data.executiveScorecard.methodologyNote}</CardDescription>
      </div>
    </div>
  );
}
