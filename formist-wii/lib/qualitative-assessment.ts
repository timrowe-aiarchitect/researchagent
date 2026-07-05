import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { EvidenceCategory, Severity } from "@/generated/prisma/enums";

const QUALITATIVE_ASSESSMENT_MODEL = "claude-sonnet-5";
const QUALITATIVE_ASSESSMENT_TIMEOUT_MS = 60000;
const QUALITATIVE_ASSESSMENT_MAX_TOKENS = 2048;
// Worst-severity-first cap so prompt size stays bounded regardless of how many pages were
// crawled, while keeping the most consequential findings in scope.
const MAX_EVIDENCE_ITEMS_FOR_PROMPT = 120;
const MAX_PAGES_FOR_PROMPT = 10;

/**
 * Exactly the system prompt supplied for this feature — do not edit it to add schema
 * instructions or anything else; those go in the user message instead, below.
 */
const SYSTEM_PROMPT = `You are a senior Formist Studio website strategist evaluating a website for the Formist Website Intelligence Index.

You must be evidence-based. Do not invent facts. Do not assume anything that is not present in the supplied crawl evidence.

Your job is to assess qualitative website strength across brand clarity, UX, conversion effectiveness, trust, and AI discoverability.

Return JSON only.`;

// Evidence categories that most directly inform the five assessed dimensions. accessibility and
// security are included as supporting UX/trust signals even though they're not literal dimension
// names, since e.g. "trust" has no dedicated evidence category of its own.
const RELEVANT_CATEGORIES: EvidenceCategory[] = [
  "brand_experience",
  "conversion",
  "ai_discoverability",
  "accessibility",
  "security",
];

const SEVERITY_RANK: Record<Severity, number> = { info: 0, minor: 1, moderate: 2, major: 3, critical: 4 };

const AssessmentDimensionSchema = z.object({
  assessment: z.string().min(1),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const QualitativeAssessmentSchema = z.object({
  brandClarity: AssessmentDimensionSchema,
  ux: AssessmentDimensionSchema,
  conversionEffectiveness: AssessmentDimensionSchema,
  trust: AssessmentDimensionSchema,
  aiDiscoverability: AssessmentDimensionSchema,
  overallNarrative: z.string().min(1),
});

export type QualitativeAssessment = z.infer<typeof QualitativeAssessmentSchema>;

export type QualitativeAssessmentInput = {
  rootUrl: string;
  pages: {
    url: string;
    title: string | null;
    metaDescription: string | null;
    h1: string | null;
    wordCount: number;
  }[];
  evidence: {
    category: EvidenceCategory;
    source: string;
    severity: Severity;
    finding: string;
    confidence: number;
    url: string | null;
  }[];
};

function summarizeEvidenceForPrompt(
  evidence: QualitativeAssessmentInput["evidence"]
): QualitativeAssessmentInput["evidence"] {
  return evidence
    .filter((e) => RELEVANT_CATEGORIES.includes(e.category))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, MAX_EVIDENCE_ITEMS_FOR_PROMPT);
}

function buildUserMessage(input: QualitativeAssessmentInput): string {
  const payload = {
    instructions:
      "Assess this website using ONLY the crawl evidence and page metadata below — do not infer or assume " +
      "anything beyond it. Respond with a single JSON object and nothing else (no markdown code fences, no " +
      "commentary outside the JSON) matching exactly this shape: " +
      '{"brandClarity":{"assessment":string,"strengths":string[],"concerns":string[],"confidence":number 0-1},' +
      '"ux":{same shape},"conversionEffectiveness":{same shape},"trust":{same shape},' +
      '"aiDiscoverability":{same shape},"overallNarrative":string}. ' +
      "Every strength and concern must cite a specific finding from the evidence below (reference the finding's " +
      "content, not the raw \"source\" key). If evidence for a dimension is sparse or absent, say so plainly in " +
      "that dimension's assessment text and lower its confidence accordingly rather than speculating.",
    rootUrl: input.rootUrl,
    pages: input.pages.slice(0, MAX_PAGES_FOR_PROMPT),
    evidence: summarizeEvidenceForPrompt(input.evidence),
  };
  return JSON.stringify(payload);
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Generates the qualitative narrative layer via the Claude API. Purely additive: the result (or
 * null) is only ever stored on Report.qualitativeAssessment and is never read by lib/scoring.ts —
 * it cannot influence any deterministic score. Never throws: a missing API key, network failure,
 * timeout, or a response that doesn't parse/validate as the expected shape all degrade to `null`
 * so a scan can never fail because of this optional enrichment step.
 */
export async function generateQualitativeAssessment(
  input: QualitativeAssessmentInput
): Promise<QualitativeAssessment | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.info("[qualitative-assessment] ANTHROPIC_API_KEY is not set — skipping.");
    return null;
  }

  try {
    const client = new Anthropic({ apiKey, timeout: QUALITATIVE_ASSESSMENT_TIMEOUT_MS });
    const response = await client.messages.create({
      model: QUALITATIVE_ASSESSMENT_MODEL,
      max_tokens: QUALITATIVE_ASSESSMENT_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      console.warn("[qualitative-assessment] Response contained no text block — skipping.");
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonText(textBlock.text));
    } catch {
      console.warn("[qualitative-assessment] Response was not valid JSON — skipping.");
      return null;
    }

    const result = QualitativeAssessmentSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(
        "[qualitative-assessment] Response failed schema validation — skipping.",
        result.error.message
      );
      return null;
    }

    return result.data;
  } catch (err) {
    console.warn(
      "[qualitative-assessment] Failed to generate — skipping.",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
