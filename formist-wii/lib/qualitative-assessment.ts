import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CATEGORY_MAX_POINTS } from "@/lib/scoring";
import type { EvidenceCategory, Severity } from "@/generated/prisma/enums";

const QUALITATIVE_ASSESSMENT_MODEL = "claude-sonnet-5";
const QUALITATIVE_ASSESSMENT_TIMEOUT_MS = 60000;
const QUALITATIVE_ASSESSMENT_MAX_TOKENS = 2048;
// Worst-severity-first cap so prompt size stays bounded regardless of how many pages were
// crawled, while keeping the most consequential findings in scope.
const MAX_EVIDENCE_ITEMS_PER_BUCKET = 40;
const MAX_PAGES_FOR_PROMPT = 10;

/**
 * Exactly the system prompt supplied for this feature — do not edit it to add schema
 * instructions or anything else; those go in the user message instead, below.
 */
const SYSTEM_PROMPT = `You are a senior Formist Studio website strategist evaluating a website for the Formist Website Intelligence Index.

You must be evidence-based. Do not invent facts. Do not assume anything that is not present in the supplied crawl evidence.

Your job is to assess qualitative website strength across brand clarity, UX, conversion effectiveness, trust, and AI discoverability.

Return JSON only.`;

// technical_seo/on_page_seo/performance/accessibility/security/analytics/wordpress_maintainability
// all feed "technicalEvidence" as supporting context — they aren't one of the three qualitatively
// scored dimensions below, but they inform judgment about them (e.g. slow pages hurt UX).
const TECHNICAL_SUPPORTING_CATEGORIES: EvidenceCategory[] = [
  "technical_seo",
  "on_page_seo",
  "performance",
  "accessibility",
  "security",
  "analytics",
  "wordpress_maintainability",
];

const SEVERITY_RANK: Record<Severity, number> = { info: 0, minor: 1, moderate: 2, major: 3, critical: 4 };

const AssessmentDimensionSchema = z.object({
  score: z.number(),
  maxScore: z.number(),
  rationale: z.string().min(1),
  evidence: z.array(z.string()),
  recommendations: z.array(z.string()),
  confidence: z.enum(["Low", "Medium", "High"]),
});

const QualitativeAssessmentSchema = z.object({
  brandExperience: AssessmentDimensionSchema,
  uxConversion: AssessmentDimensionSchema,
  aiDiscoverability: AssessmentDimensionSchema,
});

export type QualitativeAssessment = z.infer<typeof QualitativeAssessmentSchema>;

export type QualitativeAssessmentInput = {
  clientName: string | null;
  industry: string | null;
  conversionGoal: string | null;
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

type EvidenceForPrompt = QualitativeAssessmentInput["evidence"][number];

function capBySeverity(evidence: EvidenceForPrompt[]): EvidenceForPrompt[] {
  return [...evidence]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, MAX_EVIDENCE_ITEMS_PER_BUCKET);
}

function formatEvidenceBlock(evidence: EvidenceForPrompt[]): string {
  if (evidence.length === 0) return "[]";
  return JSON.stringify(evidence);
}

function buildUserMessage(input: QualitativeAssessmentInput): string {
  const pageEvidence = input.pages.slice(0, MAX_PAGES_FOR_PROMPT);
  const conversionEvidence = capBySeverity(input.evidence.filter((e) => e.category === "conversion"));
  const brandEvidence = capBySeverity(input.evidence.filter((e) => e.category === "brand_experience"));
  const aiEvidence = capBySeverity(input.evidence.filter((e) => e.category === "ai_discoverability"));
  const technicalEvidence = capBySeverity(
    input.evidence.filter((e) => TECHNICAL_SUPPORTING_CATEGORIES.includes(e.category))
  );

  return `Evaluate this website evidence.

Client:
${input.clientName ?? "Not specified"}

Industry:
${input.industry ?? "Not specified"}

Primary conversion goal:
${input.conversionGoal ?? "Not specified"}

Crawled page evidence:
${JSON.stringify(pageEvidence)}

Technical evidence:
${formatEvidenceBlock(technicalEvidence)}

Conversion evidence:
${formatEvidenceBlock(conversionEvidence)}

Brand evidence:
${formatEvidenceBlock(brandEvidence)}

AI discoverability evidence:
${formatEvidenceBlock(aiEvidence)}

Return JSON in this exact structure:

{
  "brandExperience": {
    "score": 0,
    "maxScore": ${CATEGORY_MAX_POINTS.brand_experience},
    "rationale": "",
    "evidence": [],
    "recommendations": [],
    "confidence": "Low|Medium|High"
  },
  "uxConversion": {
    "score": 0,
    "maxScore": ${CATEGORY_MAX_POINTS.conversion},
    "rationale": "",
    "evidence": [],
    "recommendations": [],
    "confidence": "Low|Medium|High"
  },
  "aiDiscoverability": {
    "score": 0,
    "maxScore": ${CATEGORY_MAX_POINTS.ai_discoverability},
    "rationale": "",
    "evidence": [],
    "recommendations": [],
    "confidence": "Low|Medium|High"
  }
}

Scoring rules:
- Be conservative.
- Use only supplied evidence.
- If evidence is incomplete, lower confidence.
- Do not mention tools.
- Write in a professional consulting tone.`;
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Locks each dimension's maxScore to the canonical scoring-engine constant (never whatever the
 * model echoed back) and clamps score into [0, maxScore] — the model's own arithmetic is treated
 * as advisory text, not a source of truth for the point scale.
 */
function normalizeDimension(
  dimension: z.infer<typeof AssessmentDimensionSchema>,
  canonicalMaxScore: number
): z.infer<typeof AssessmentDimensionSchema> {
  return {
    ...dimension,
    maxScore: canonicalMaxScore,
    score: Math.max(0, Math.min(canonicalMaxScore, dimension.score)),
  };
}

/**
 * Generates the qualitative narrative + advisory scoring layer via the Claude API. Purely
 * additive: the result (or null) is only ever stored on Report.qualitativeAssessment and is
 * never read by lib/scoring.ts — its "score" fields are the model's own qualitative point
 * estimate and can never influence or be confused with a deterministic CategoryScore. Never
 * throws: a missing API key, network failure, timeout, or a response that doesn't parse/validate
 * as the expected shape all degrade to `null` so a scan can never fail because of this optional
 * enrichment step.
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

    return {
      brandExperience: normalizeDimension(result.data.brandExperience, CATEGORY_MAX_POINTS.brand_experience),
      uxConversion: normalizeDimension(result.data.uxConversion, CATEGORY_MAX_POINTS.conversion),
      aiDiscoverability: normalizeDimension(
        result.data.aiDiscoverability,
        CATEGORY_MAX_POINTS.ai_discoverability
      ),
    };
  } catch (err) {
    console.warn(
      "[qualitative-assessment] Failed to generate — skipping.",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
