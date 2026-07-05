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

  const run = await prisma.run.findUnique({ where: { id } });
  if (!run) return jsonError(404, "Scan not found");

  if (!RESTARTABLE_STATUSES.has(run.status)) {
    return NextResponse.json(
      { id: run.id, status: run.status, message: "Scan is already running or complete." },
      { status: 200 }
    );
  }

  if (run.status === "failed") {
    await prisma.run.update({
      where: { id },
      data: { status: "queued", failureReason: null, completedAt: null },
    });
  }

  await scanQueue.add(
    "run-scan",
    { runId: id },
    { jobId: id }
  );

  return NextResponse.json({ id, status: "queued" }, { status: 202 });
}
