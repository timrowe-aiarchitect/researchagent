import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export function zodErrorResponse(error: ZodError) {
  return NextResponse.json(
    { error: "Validation failed", issues: error.issues },
    { status: 400 }
  );
}

export function rootUrlFromInput(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}/`;
}
