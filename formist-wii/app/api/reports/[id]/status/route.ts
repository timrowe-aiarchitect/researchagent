import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { updateReportStatus } from "@/lib/report-review";
import { reportStatusBodySchema, reportStatusParamsSchema } from "@/lib/validations";
import { jsonError, zodErrorResponse } from "@/lib/api-utils";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let parsedParams;
  try {
    parsedParams = reportStatusParamsSchema.parse(await params);
  } catch (error) {
    if (error instanceof ZodError) return zodErrorResponse(error);
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON");
  }

  let input;
  try {
    input = reportStatusBodySchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return zodErrorResponse(error);
    throw error;
  }

  const result = await updateReportStatus({
    reportId: parsedParams.id,
    status: input.status,
    reviewerName: input.reviewerName,
  });

  if (!result.ok) return jsonError(400, result.error);

  return NextResponse.json(result);
}
