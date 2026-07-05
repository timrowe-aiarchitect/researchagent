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
import { GradeBadge, RiskBadge } from "@/components/status-badges";
import { ExportPdfButton } from "@/components/export-pdf-button";

export const dynamic = "force-dynamic";

function readinessLabel(score: number): "Low" | "Medium" | "High" {
  if (score >= 80) return "High";
  if (score >= 50) return "Medium";
  return "Low";
}

const SEVERITY_VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  info: "secondary",
  minor: "secondary",
  moderate: "warning",
  major: "destructive",
  critical: "destructive",
};

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const report = await getReportPayload(id);
  if (!report) notFound();

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 print:max-w-none print:px-0">
      {/* 1. Cover / Summary */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm font-medium">Website Intelligence Index Report</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight break-all">
            {report.website.rootUrl}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Generated {new Date(report.generatedAt).toLocaleString()} · {report.pagesCrawled} pages
            crawled
            {report.website.detectedCms === "wordpress" && " · WordPress detected"}
          </p>
        </div>
        <ExportPdfButton />
      </div>

      {/* 2 & 3. Executive summary + overall score */}
      <Card className="mt-6">
        <CardContent className="flex flex-wrap items-center gap-8 pt-6 pb-6">
          <div className="flex flex-col items-center gap-1">
            <div className="flex size-24 items-center justify-center rounded-full border-4 border-primary/20 text-3xl font-bold">
              {report.overallScore}
            </div>
            <GradeBadge grade={report.grade} className="mt-1" />
            <span className="text-muted-foreground text-xs">Overall WII score</span>
          </div>
          <Separator orientation="vertical" className="hidden h-20 sm:block" />
          <div className="flex-1 min-w-[240px]">
            <p className="text-sm leading-relaxed">{report.executiveSummary}</p>
          </div>
        </CardContent>
      </Card>

      {/* 4 & 5. Business risk + AI readiness */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Business risk
              <RiskBadge risk={report.businessRisk} />
            </CardTitle>
            <CardDescription>
              Derived from Security, Technical SEO, Accessibility, and WordPress maintainability findings.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              AI readiness
              <Badge variant="secondary">{report.aiReadiness}/100 · {readinessLabel(report.aiReadiness)}</Badge>
            </CardTitle>
            <CardDescription>
              How easily AI crawlers and assistants can discover and parse this site&apos;s content.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      {/* 6 & 7. Category scores + evidence */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Category scores</h2>
        <p className="text-muted-foreground text-sm">Every score below is backed by concrete evidence.</p>

        <div className="mt-4 flex flex-col gap-4">
          {report.categoryScores.map((cs) => (
            <Card key={cs.category} className="break-inside-avoid">
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{cs.label}</span>
                  <span className="text-muted-foreground text-sm font-normal">{cs.score}/100</span>
                </CardTitle>
                <Progress value={cs.score} className="mt-1" />
                <CardDescription>{cs.summary}</CardDescription>
              </CardHeader>
              {cs.evidence.length > 0 && (
                <CardContent className="pb-6">
                  <ul className="flex flex-col gap-2">
                    {cs.evidence.map((e) => (
                      <li key={e.id} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium capitalize">{e.checkName.replace(/_/g, " ")}</span>
                          <Badge variant={SEVERITY_VARIANT[e.severity]} className="capitalize">
                            {e.severity}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground">{e.detail}</p>
                        {e.pageUrl && (
                          <p className="text-muted-foreground truncate text-xs">{e.pageUrl}</p>
                        )}
                        {e.recommendation && (
                          <p className="text-foreground text-xs">
                            <span className="font-medium">Recommendation: </span>
                            {e.recommendation}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      </div>

      {/* 8. Priority roadmap */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Priority roadmap</h2>
        <p className="text-muted-foreground text-sm">Ranked by business impact vs. estimated effort.</p>
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
                {report.roadmap.map((item) => (
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
                {report.roadmap.length === 0 && (
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

      {/* 9. Client-ready recommendations */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Client-ready recommendations</h2>
        <Card className="mt-4">
          <CardContent className="pb-6 pt-6">
            {report.recommendations.length > 0 ? (
              <ul className="list-disc space-y-2 pl-5 text-sm">
                {report.recommendations.map((rec, i) => (
                  <li key={i}>{rec}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">No outstanding recommendations.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 10. Methodology & limitations */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Methodology &amp; limitations</h2>
        <Card className="mt-4">
          <CardContent className="pb-6 pt-6 text-sm text-muted-foreground">
            <p>{report.methodologyNote}</p>
            <p className="mt-2">
              This scan crawled up to {report.pagesCrawled} publicly reachable pages. Categories with
              limited crawlable data may show reduced confidence. This report is an automated
              diagnostic and is not a substitute for a manual legal accessibility or security audit.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 11. Appendix: full page list */}
      <div className="mt-8 mb-12">
        <h2 className="text-lg font-semibold tracking-tight">Appendix: crawled pages</h2>
        <Card className="mt-4">
          <CardContent className="pb-6 pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>HTTP status</TableHead>
                  <TableHead>Crawl status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.pages.map((p) => (
                  <TableRow key={p.url}>
                    <TableCell className="max-w-md truncate">{p.url}</TableCell>
                    <TableCell>{p.httpStatus ?? "—"}</TableCell>
                    <TableCell className="capitalize">{p.crawlStatus.replace(/_/g, " ")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
