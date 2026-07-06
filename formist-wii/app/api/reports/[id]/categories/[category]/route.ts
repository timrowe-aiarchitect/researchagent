import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { updateCategoryReview } from "@/lib/report-review";
import { categoryReviewBodySchema, categoryReviewParamsSchema } from "@/lib/validations";
import { jsonError, zodErrorResponse } from "@/lib/api-utils";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; category: string }> }
) {
  let parsedParams;
  try {
    parsedParams = categoryReviewParamsSchema.parse(await params);
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
    input = categoryReviewBodySchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return zodErrorResponse(error);
    throw error;
  }

  const result = await updateCategoryReview({
    reportId: parsedParams.id,
    category: parsedParams.category,
    rationale: input.rationale,
    score: input.score,
    note: input.note ?? null,
    reviewerName: input.reviewerName,
  });

  if (!result.ok) return jsonError(400, result.error);

  return NextResponse.json(result.summary);
}
