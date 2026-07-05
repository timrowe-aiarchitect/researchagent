import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-utils";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const run = await prisma.run.findUnique({
    where: { id },
    include: { website: true, report: { select: { id: true } } },
  });

  if (!run) return jsonError(404, "Scan not found");

  return NextResponse.json({
    id: run.id,
    websiteId: run.websiteId,
    rootUrl: run.website.rootUrl,
    detectedCms: run.website.detectedCms,
    status: run.status,
    pagesRequested: run.pagesRequested,
    pagesCrawled: run.pagesCrawled,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    failureReason: run.failureReason,
    createdAt: run.createdAt,
    reportId: run.report?.id ?? null,
  });
}
