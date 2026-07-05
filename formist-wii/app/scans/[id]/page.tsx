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

  const scan = await prisma.scan.findUnique({
    where: { id },
    include: { client: true, report: { select: { id: true } } },
  });

  if (!scan) notFound();

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Scan status</h1>
      <p className="text-muted-foreground mt-1 truncate text-sm">{scan.client.rootUrl}</p>

      <ScanStatus
        scanId={scan.id}
        initial={{
          status: scan.status,
          pagesRequested: scan.pagesRequested,
          pagesCrawled: scan.pagesCrawled,
          failureReason: scan.failureReason,
          reportId: scan.report?.id ?? null,
        }}
      />
    </div>
  );
}
