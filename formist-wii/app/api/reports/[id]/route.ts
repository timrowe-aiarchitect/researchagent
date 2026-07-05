import { NextResponse } from "next/server";

import { getReportPayload } from "@/lib/reports";
import { jsonError } from "@/lib/api-utils";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const report = await getReportPayload(id);
  if (!report) return jsonError(404, "Report not found");

  return NextResponse.json(report);
}
