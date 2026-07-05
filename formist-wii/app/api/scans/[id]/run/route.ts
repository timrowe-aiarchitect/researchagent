import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { scanQueue } from "@/lib/queue";
import { jsonError } from "@/lib/api-utils";

const RESTARTABLE_STATUSES = new Set(["queued", "failed"]);

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const scan = await prisma.scan.findUnique({ where: { id } });
  if (!scan) return jsonError(404, "Scan not found");

  if (!RESTARTABLE_STATUSES.has(scan.status)) {
    return NextResponse.json(
      { id: scan.id, status: scan.status, message: "Scan is already running or complete." },
      { status: 200 }
    );
  }

  if (scan.status === "failed") {
    await prisma.scan.update({
      where: { id },
      data: { status: "queued", failureReason: null, completedAt: null },
    });
  }

  await scanQueue.add(
    "run-scan",
    { scanId: id },
    { jobId: id }
  );

  return NextResponse.json({ id, status: "queued" }, { status: 202 });
}
