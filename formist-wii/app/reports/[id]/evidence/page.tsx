import { notFound } from "next/navigation";

import { getReportPayload } from "@/lib/reports";
import { ReportSubNav } from "@/components/report-sub-nav";
import { EvidenceTable, type EvidenceRow } from "@/components/evidence-table";

export const dynamic = "force-dynamic";

export default async function EvidencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const report = await getReportPayload(id);
  if (!report) notFound();

  const { data } = report;

  const rows: EvidenceRow[] = data.appendixEvidence.flatMap((group) =>
    group.items.map((item) => ({
      category: group.category,
      categoryLabel: group.categoryLabel,
      source: item.source,
      severity: item.severity,
      finding: item.finding,
      url: item.url,
    }))
  );

  const categories = data.appendixEvidence.map((group) => ({
    value: group.category,
    label: group.categoryLabel,
  }));

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <ReportSubNav reportId={id} active="evidence" />

      <div>
        <p className="text-muted-foreground text-sm font-medium">Evidence</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight break-all">
          {data.cover.clientName ?? data.cover.rootUrl}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every finding behind every score, filterable by category and severity.
        </p>
      </div>

      <div className="mt-6">
        <EvidenceTable rows={rows} categories={categories} />
      </div>
    </div>
  );
}
