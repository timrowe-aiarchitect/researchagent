import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-utils";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const scan = await prisma.scan.findUnique({
    where: { id },
    include: { client: true, report: { select: { id: true } } },
  });

  if (!scan) return jsonError(404, "Scan not found");

  return NextResponse.json({
    id: scan.id,
    clientId: scan.clientId,
    rootUrl: scan.client.rootUrl,
    detectedCms: scan.client.detectedCms,
    status: scan.status,
    pagesRequested: scan.pagesRequested,
    pagesCrawled: scan.pagesCrawled,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    failureReason: scan.failureReason,
    createdAt: scan.createdAt,
    reportId: scan.report?.id ?? null,
  });
}
