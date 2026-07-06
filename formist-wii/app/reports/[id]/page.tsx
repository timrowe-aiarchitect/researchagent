import Image from "next/image";
import { notFound } from "next/navigation";

import { getReportPayload } from "@/lib/reports";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GradeBadge, RiskBadge, CategoryStatusBadge, SeverityBadge } from "@/components/status-badges";
import { ExportPdfButton } from "@/components/export-pdf-button";
import { ReportSubNav } from "@/components/report-sub-nav";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const report = await getReportPayload(id);
  if (!report) notFound();

  const { data } = report;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 print:max-w-none print:px-0">
      <ReportSubNav reportId={id} active="report" />

      {/* 1. Cover */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm font-medium">Website Intelligence Index Report</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight break-all">
            {data.cover.clientName ?? data.cover.rootUrl}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Generated {new Date(data.cover.generatedAt).toLocaleString()} · {data.cover.pagesCrawled} of{" "}
            {data.cover.pagesRequested} pages crawled
            {data.cover.detectedCms === "wordpress" && " · WordPress detected"}
          </p>
        </div>
        <ExportPdfButton pdfUrl={report.pdfUrl} />
      </div>
      <Card className="mt-6">
        <CardContent className="flex items-center gap-4 pt-6 pb-6">
          <div className="flex size-24 items-center justify-center rounded-full border-4 border-primary/20 text-3xl font-bold">
            {data.cover.overallScore}
          </div>
          <GradeBadge grade={data.cover.grade} />
        </CardContent>
      </Card>

      {/* 2. Executive Summary */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Executive Summary</h2>
        <Card className="mt-4">
          <CardContent className="pt-6 pb-6 text-sm leading-relaxed">{data.executiveSummary}</CardContent>
        </Card>
        {(data.topRisks.length > 0 || data.topOpportunities.length > 0) && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {data.topRisks.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Top risks</CardTitle>
                </CardHeader>
                <CardContent className="pb-6">
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {data.topRisks.map((risk, i) => (
                      <li key={i}>{risk}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
            {data.topOpportunities.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Top opportunities</CardTitle>
                </CardHeader>
                <CardContent className="pb-6">
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {data.topOpportunities.map((opportunity, i) => (
                      <li key={i}>{opportunity}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* 3. Executive Scorecard */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Executive Scorecard</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                Business risk
                <RiskBadge risk={data.executiveScorecard.businessRisk} />
              </CardTitle>
              {data.executiveScorecard.businessRiskDrivers.length > 0 && (
                <CardDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {data.executiveScorecard.businessRiskDrivers.map((driver, i) => (
                      <li key={i}>{driver}</li>
                    ))}
                  </ul>
                </CardDescription>
              )}
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                AI readiness
                <Badge variant="secondary">
                  {data.executiveScorecard.aiReadiness.score}/100 · {data.executiveScorecard.aiReadiness.label}
                </Badge>
              </CardTitle>
              <CardDescription>
                How easily AI crawlers and assistants can discover and parse this site&apos;s content.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                Priority
                <RiskBadge risk={data.executiveScorecard.priority} />
              </CardTitle>
              <CardDescription>How urgently this site should be prioritized for engagement.</CardDescription>
            </CardHeader>
          </Card>
        </div>
        <p className="text-muted-foreground mt-4 text-sm">{data.executiveScorecard.methodologyNote}</p>
      </div>

      {/* 4. Overall Website Intelligence Index */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Overall Website Intelligence Index</h2>
        <Card className="mt-4">
          <CardContent className="flex flex-col gap-4 pt-6 pb-6">
            <div className="flex items-center gap-3">
              <span className="text-3xl font-bold">{data.overallIndex.overallScore}</span>
              <span className="text-muted-foreground text-sm">/100 · Grade {data.overallIndex.grade}</span>
            </div>
            <Separator />
            <ul className="flex flex-col gap-3">
              {data.overallIndex.categoryBreakdown.map((c) => (
                <li key={c.category} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{c.label}</span>
                    <span className="text-muted-foreground">
                      {c.score}/{c.maxScore}
                    </span>
                  </div>
                  <Progress value={(c.score / c.maxScore) * 100} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* 5. Key Findings */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Key Findings</h2>
        <Card className="mt-4">
          <CardContent className="pt-6 pb-6">
            {data.keyFindings.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {data.keyFindings.map((f, i) => (
                  <li key={i} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground text-xs">{f.categoryLabel}</span>
                      <SeverityBadge severity={f.severity} />
                    </div>
                    <p>{f.finding}</p>
                    {f.url && <p className="text-muted-foreground truncate text-xs">{f.url}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">
                No significant findings — the site is in solid shape across all categories.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 6. Category Deep Dives */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Category Deep Dives</h2>
        <div className="mt-4 flex flex-col gap-4">
          {data.categoryDeepDives.map((cs) => (
            <Card key={cs.category} className="break-inside-avoid">
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{cs.label}</span>
                  <div className="flex items-center gap-2">
                    <CategoryStatusBadge status={cs.status} />
                    <span className="text-muted-foreground text-sm font-normal">
                      {cs.score}/{cs.maxScore}
                    </span>
                  </div>
                </CardTitle>
                <Progress value={(cs.score / cs.maxScore) * 100} className="mt-1" />
                <CardDescription>{cs.rationale}</CardDescription>
              </CardHeader>
              {cs.evidence.length > 0 && (
                <CardContent className="pb-6">
                  <ul className="flex flex-col gap-2">
                    {cs.evidence.map((e, i) => (
                      <li key={i} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium capitalize">{e.source.replace(/_/g, " ")}</span>
                          <SeverityBadge severity={e.severity} />
                        </div>
                        <p className="text-muted-foreground">{e.finding}</p>
                        {e.url && <p className="text-muted-foreground truncate text-xs">{e.url}</p>}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      </div>

      {/* 7. AI Discoverability Assessment */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">AI Discoverability Assessment</h2>
        <Card className="mt-4 break-inside-avoid">
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span>AI Discoverability</span>
              <div className="flex items-center gap-2">
                <CategoryStatusBadge status={data.aiDiscoverabilityAssessment.status} />
                <span className="text-muted-foreground text-sm font-normal">
                  {data.aiDiscoverabilityAssessment.score}/{data.aiDiscoverabilityAssessment.maxScore}
                </span>
              </div>
            </CardTitle>
            <Progress
              value={
                (data.aiDiscoverabilityAssessment.score / data.aiDiscoverabilityAssessment.maxScore) * 100
              }
              className="mt-1"
            />
            <CardDescription>{data.aiDiscoverabilityAssessment.rationale}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pb-6">
            {data.aiDiscoverabilityAssessment.strategistPerspective && (
              <div className="bg-muted rounded-md p-3 text-sm">
                <p className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                  Strategist perspective
                </p>
                <p>{data.aiDiscoverabilityAssessment.strategistPerspective.rationale}</p>
              </div>
            )}
            {data.aiDiscoverabilityAssessment.evidence.length > 0 && (
              <ul className="flex flex-col gap-2">
                {data.aiDiscoverabilityAssessment.evidence.map((e, i) => (
                  <li key={i} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium capitalize">{e.source.replace(/_/g, " ")}</span>
                      <SeverityBadge severity={e.severity} />
                    </div>
                    <p className="text-muted-foreground">{e.finding}</p>
                    {e.url && <p className="text-muted-foreground truncate text-xs">{e.url}</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 8. WordPress Maintainability Assessment */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">WordPress Maintainability Assessment</h2>
        {data.wordpressMaintainabilityAssessment.applicable ? (
          <Card className="mt-4 break-inside-avoid">
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>WordPress Maintainability</span>
                <div className="flex items-center gap-2">
                  <CategoryStatusBadge status={data.wordpressMaintainabilityAssessment.status} />
                  <span className="text-muted-foreground text-sm font-normal">
                    {data.wordpressMaintainabilityAssessment.score}/
                    {data.wordpressMaintainabilityAssessment.maxScore}
                  </span>
                </div>
              </CardTitle>
              <Progress
                value={
                  (data.wordpressMaintainabilityAssessment.score /
                    data.wordpressMaintainabilityAssessment.maxScore) *
                  100
                }
                className="mt-1"
              />
              <CardDescription>{data.wordpressMaintainabilityAssessment.rationale}</CardDescription>
            </CardHeader>
            {data.wordpressMaintainabilityAssessment.evidence.length > 0 && (
              <CardContent className="pb-6">
                <ul className="flex flex-col gap-2">
                  {data.wordpressMaintainabilityAssessment.evidence.map((e, i) => (
                    <li key={i} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium capitalize">{e.source.replace(/_/g, " ")}</span>
                        <SeverityBadge severity={e.severity} />
                      </div>
                      <p className="text-muted-foreground">{e.finding}</p>
                      {e.url && <p className="text-muted-foreground truncate text-xs">{e.url}</p>}
                    </li>
                  ))}
                </ul>
              </CardContent>
            )}
          </Card>
        ) : (
          <Card className="mt-4">
            <CardContent className="text-muted-foreground pt-6 pb-6 text-sm">
              {data.wordpressMaintainabilityAssessment.note}
            </CardContent>
          </Card>
        )}
      </div>

      {/* 9. Priority Roadmap */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Priority Roadmap</h2>
        <p className="text-muted-foreground text-sm">{data.priorityRoadmapNarrative}</p>
        <Card className="mt-4">
          <CardContent className="pb-6 pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Impact</TableHead>
                  <TableHead>Effort</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.priorityRoadmap.map((item) => (
                  <TableRow key={item.priorityRank}>
                    <TableCell className="font-medium">{item.priorityRank}</TableCell>
                    <TableCell className="max-w-md whitespace-normal">
                      <p className="font-medium capitalize">{item.title}</p>
                      <p className="text-muted-foreground text-xs">{item.recommendation}</p>
                    </TableCell>
                    <TableCell>{item.categoryLabel}</TableCell>
                    <TableCell>{item.impact}</TableCell>
                    <TableCell>{item.effort}</TableCell>
                  </TableRow>
                ))}
                {data.priorityRoadmap.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground text-center">
                      No high-priority issues found — nice work.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* 10. Recommended Next Steps */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Recommended Next Steps</h2>
        <Card className="mt-4">
          <CardContent className="pb-6 pt-6">
            {data.recommendedNextSteps.length > 0 ? (
              <ul className="list-disc space-y-2 pl-5 text-sm">
                {data.recommendedNextSteps.map((rec, i) => (
                  <li key={i}>{rec}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">No outstanding recommendations.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Site snapshots */}
      {data.screenshots.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Site Snapshots</h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {data.screenshots.map((s) => (
              <figure key={s.pageUrl} className="overflow-hidden rounded-md border">
                <Image
                  src={`/${s.path.replace(/^\/+/, "")}`}
                  alt={`Screenshot of ${s.pageUrl}`}
                  width={800}
                  height={600}
                  className="w-full"
                  unoptimized
                />
                <figcaption className="text-muted-foreground truncate p-2 text-xs">{s.pageUrl}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      {/* 11. Appendix: Evidence */}
      <div className="mt-8 mb-12">
        <h2 className="text-lg font-semibold tracking-tight">Appendix: Evidence</h2>
        <p className="text-muted-foreground text-sm">
          Every finding behind every score, organized by category, for full traceability.
        </p>
        <div className="mt-4 flex flex-col gap-4">
          {data.appendixEvidence.map((group) => (
            <Card key={group.category}>
              <CardHeader>
                <CardTitle className="text-base">{group.categoryLabel}</CardTitle>
              </CardHeader>
              <CardContent className="pb-6">
                <ul className="flex flex-col gap-2">
                  {group.items.map((e, i) => (
                    <li key={i} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium capitalize">{e.source.replace(/_/g, " ")}</span>
                        <SeverityBadge severity={e.severity} />
                      </div>
                      <p className="text-muted-foreground">{e.finding}</p>
                      {e.url && <p className="text-muted-foreground truncate text-xs">{e.url}</p>}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
