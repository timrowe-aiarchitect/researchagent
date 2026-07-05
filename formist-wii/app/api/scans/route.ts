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

  // Only fill these in if the caller actually supplied them — never blank out a previously-set
  // name/industry/goal on a repeat scan of the same client just because a later request omitted them.
  const clientAttributes = {
    ...(input.clientName ? { name: input.clientName } : {}),
    ...(input.industry ? { industry: input.industry } : {}),
    ...(input.conversionGoal ? { conversionGoal: input.conversionGoal } : {}),
  };

  const client = await prisma.client.upsert({
    where: { rootUrl },
    update: clientAttributes,
    create: { rootUrl, ...clientAttributes },
  });

  const scan = await prisma.scan.create({
    data: {
      clientId: client.id,
      requestedBy: input.requestedBy,
      status: "queued",
      pagesRequested: 25,
    },
  });

  return NextResponse.json(
    {
      id: scan.id,
      clientId: client.id,
      rootUrl: client.rootUrl,
      status: scan.status,
      pagesRequested: scan.pagesRequested,
      createdAt: scan.createdAt,
    },
    { status: 201 }
  );
}
