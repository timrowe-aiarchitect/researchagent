import { notFound } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { ScanStatus } from "@/components/scan-status";

export const dynamic = "force-dynamic";

export default async function ScanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const run = await prisma.run.findUnique({
    where: { id },
    include: { website: true, report: { select: { id: true } } },
  });

  if (!run) notFound();

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Scan status</h1>
      <p className="text-muted-foreground mt-1 truncate text-sm">{run.website.rootUrl}</p>

      <ScanStatus
        scanId={run.id}
        initial={{
          status: run.status,
          pagesRequested: run.pagesRequested,
          pagesCrawled: run.pagesCrawled,
          failureReason: run.failureReason,
          reportId: run.report?.id ?? null,
        }}
      />
    </div>
  );
}
