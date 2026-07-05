import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { prisma } from "@/lib/prisma";
import { createScanSchema } from "@/lib/validations";
import { jsonError, rootUrlFromInput, zodErrorResponse } from "@/lib/api-utils";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON");
  }

  let input;
  try {
    input = createScanSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return zodErrorResponse(error);
    throw error;
  }

  const rootUrl = rootUrlFromInput(input.url);

  const website = await prisma.website.upsert({
    where: { rootUrl },
    update: {},
    create: { rootUrl },
  });

  const run = await prisma.run.create({
    data: {
      websiteId: website.id,
      requestedBy: input.requestedBy,
      status: "queued",
      pagesRequested: 25,
    },
  });

  return NextResponse.json(
    {
      id: run.id,
      websiteId: website.id,
      rootUrl: website.rootUrl,
      status: run.status,
      pagesRequested: run.pagesRequested,
      createdAt: run.createdAt,
    },
    { status: 201 }
  );
}
