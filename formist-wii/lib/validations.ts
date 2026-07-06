import { z } from "zod";
import { EvidenceCategory, ReportStatus } from "@/generated/prisma/enums";

const PRIVATE_HOSTNAMES = new Set(["localhost", "0.0.0.0", "::1"]);

// Matches RFC 1918 / loopback / link-local ranges so we don't crawl internal infrastructure.
const PRIVATE_IPV4_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
];

export function isPublicHttpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (PRIVATE_HOSTNAMES.has(hostname)) {
    return false;
  }
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return false;
  }
  if (PRIVATE_IPV4_RANGES.some((pattern) => pattern.test(hostname))) {
    return false;
  }

  return true;
}

export function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  if (parsed.pathname === "") {
    parsed.pathname = "/";
  }
  return parsed.toString();
}

export const createScanSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "URL is required")
    .url("Enter a valid URL, including https://")
    .refine(isPublicHttpUrl, {
      message:
        "URL must be a public http(s) address (no localhost or private network hosts)",
    }),
  requestedBy: z.string().trim().min(1).max(200).default("internal"),
  // All optional — never required to run a scan. Used only as context for the LLM qualitative
  // assessment (lib/qualitative-assessment.ts); the deterministic crawl/scoring pipeline ignores them.
  clientName: z.string().trim().min(1).max(200).optional(),
  industry: z.string().trim().min(1).max(200).optional(),
  conversionGoal: z.string().trim().min(1).max(200).optional(),
});

export type CreateScanInput = z.infer<typeof createScanSchema>;

export const runScanParamsSchema = z.object({
  id: z.string().min(1),
});

export const getScanParamsSchema = z.object({
  id: z.string().min(1),
});

export const getReportParamsSchema = z.object({
  id: z.string().min(1),
});

const EVIDENCE_CATEGORIES = Object.values(EvidenceCategory) as [EvidenceCategory, ...EvidenceCategory[]];
const REPORT_STATUSES = Object.values(ReportStatus) as [ReportStatus, ...ReportStatus[]];

export const categoryReviewParamsSchema = z.object({
  id: z.string().min(1),
  category: z.enum(EVIDENCE_CATEGORIES),
});

export const categoryReviewBodySchema = z.object({
  rationale: z.string().trim().min(1, "Rationale is required").max(4000),
  score: z.number().finite(),
  // Required whenever the submitted score differs from the automated one — enforced again in
  // lib/report-review.ts, which is the actual source of truth for that rule.
  note: z.string().trim().max(2000).nullable().optional(),
  reviewerName: z.string().trim().min(1).max(200).default("internal"),
});

export const reportStatusParamsSchema = z.object({
  id: z.string().min(1),
});

export const reportStatusBodySchema = z.object({
  status: z.enum(REPORT_STATUSES),
  reviewerName: z.string().trim().min(1).max(200).default("internal"),
});
