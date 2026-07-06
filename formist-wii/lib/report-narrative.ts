import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CATEGORY_LABELS, type BusinessRisk, type Grade, type Priority, type ReadinessLabel } from "@/lib/scoring";
import type {
  ReportCategoryScoreInput,
  ReportEvidenceInput,
  ReportRecommendationInput,
} from "@/lib/report-service";
import { EvidenceCategory, type Severity } from "@/generated/prisma/enums";

const NARRATIVE_MODEL = "claude-sonnet-5";
const NARRATIVE_TIMEOUT_MS = 60000;
const NARRATIVE_MAX_TOKENS = 4096;
// Worst-severity-first cap per category so prompt size stays bounded regardless of how many
// pages were crawled, while keeping the most consequential findings in scope.
const MAX_EVIDENCE_ITEMS_PER_CATEGORY = 15;
const TOP_LIST_LIMIT = 5;

const EVIDENCE_CATEGORIES = Object.values(EvidenceCategory) as [EvidenceCategory, ...EvidenceCategory[]];
const SEVERITY_RANK: Record<Severity, number> = { info: 0, minor: 1, moderate: 2, major: 3, critical: 4 };

/**
 * Exactly the prompt supplied for this feature — the fixed persona/instructions portion becomes
 * the system prompt; do not edit it to add schema instructions or anything else (those live in
 * the {{reportStructure}} substitution in the user message instead, below).
 */
const SYSTEM_PROMPT = `You are writing a client-ready Formist Website Intelligence Index report.

Use the supplied scores and evidence. Do not change the scores.

Write:
- Executive summary
- Top 5 risks
- Top 5 opportunities
- Category summaries
- Priority roadmap
- Recommended next steps

Tone:
- Clear
- Strategic
- Direct
- Human-centered
- Business-focused
- No exaggerated claims`;

const CategorySummarySchema = z.object({
  category: z.enum(EVIDENCE_CATEGORIES),
  summary: z.string().min(1),
});

const NarrativeReportSchema = z.object({
  executiveSummary: z.string().min(1),
  topRisks: z.array(z.string()),
  topOpportunities: z.array(z.string()),
  categorySummaries: z.array(CategorySummarySchema),
  priorityRoadmapNarrative: z.string().min(1),
  recommendedNextSteps: z.array(z.string()),
});

export type NarrativeReport = z.infer<typeof NarrativeReportSchema>;

export type ReportNarrativeInput = {
  scan: { rootUrl: string; clientName: string | null; industry: string | null; conversionGoal: string | null };
  overallScore: number;
  grade: Grade;
  businessRisk: BusinessRisk;
  aiReadiness: { score: number; label: ReadinessLabel };
  priority: Priority;
  categoryScores: ReportCategoryScoreInput[];
  evidenceItems: ReportEvidenceInput[];
  recommendations: ReportRecommendationInput[];
};

function capBySeverity(evidence: ReportEvidenceInput[]): ReportEvidenceInput[] {
  return [...evidence]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, MAX_EVIDENCE_ITEMS_PER_CATEGORY);
}

function buildScoreData(input: ReportNarrativeInput): string {
  return JSON.stringify({
    rootUrl: input.scan.rootUrl,
    clientName: input.scan.clientName,
    industry: input.scan.industry,
    conversionGoal: input.scan.conversionGoal,
    overallScore: input.overallScore,
    grade: input.grade,
    businessRisk: input.businessRisk,
    aiReadiness: input.aiReadiness,
    priority: input.priority,
    categoryScores: input.categoryScores.map((cs) => ({
      category: cs.category,
      label: CATEGORY_LABELS[cs.category],
      score: cs.score,
      maxScore: cs.maxScore,
      status: cs.status,
      rationale: cs.rationale,
      confidence: cs.confidence,
    })),
  });
}

function buildEvidenceData(evidenceItems: ReportEvidenceInput[]): string {
  const byCategory = new Map<EvidenceCategory, ReportEvidenceInput[]>();
  for (const e of evidenceItems) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }
  const evidenceByCategory = Object.fromEntries(
    [...byCategory.entries()].map(([category, items]) => [
      category,
      capBySeverity(items).map((e) => ({
        source: e.source,
        severity: e.severity,
        finding: e.finding,
        url: e.url,
      })),
    ])
  );
  return JSON.stringify(evidenceByCategory);
}

function buildRecommendationData(recommendations: ReportRecommendationInput[]): string {
  return JSON.stringify(
    [...recommendations]
      .sort((a, b) => a.priorityRank - b.priorityRank)
      .map((r) => ({
        priorityRank: r.priorityRank,
        title: r.title,
        category: r.category,
        impact: r.impact,
        effort: r.effort,
        recommendation: r.recommendation,
      }))
  );
}

const REPORT_STRUCTURE = `{
  "executiveSummary": "string",
  "topRisks": ["string", "... up to ${TOP_LIST_LIMIT} items, worst first"],
  "topOpportunities": ["string", "... up to ${TOP_LIST_LIMIT} items"],
  "categorySummaries": [
    { "category": "one of: ${EVIDENCE_CATEGORIES.join(" | ")}", "summary": "string" }
  ],
  "priorityRoadmapNarrative": "string",
  "recommendedNextSteps": ["string"]
}

Respond with JSON only, matching this exact structure. Include one categorySummaries entry for
every category present in the score data below. Do not include any commentary outside the JSON.`;

function buildUserMessage(input: ReportNarrativeInput): string {
  return `Use this structure:
${REPORT_STRUCTURE}

Data:
${buildScoreData(input)}
${buildEvidenceData(input.evidenceItems)}
${buildRecommendationData(input.recommendations)}`;
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Generates the client-ready narrative prose for the report via the Claude API: executive
 * summary, top risks/opportunities, per-category summaries, a priority roadmap narrative, and
 * recommended next steps. Purely a narrative layer over already-computed scores and evidence —
 * it never invents or alters a score, status, or evidence reference; lib/report-service.ts uses
 * this text to replace the template-generated prose in ReportData, falling back to its own
 * deterministic text for any field this returns null or omits. Never throws: a missing API key,
 * network failure, timeout, or a response that doesn't parse/validate as the expected shape all
 * degrade to `null` so report generation can never fail because of this optional enrichment step.
 */
export async function generateReportNarrative(input: ReportNarrativeInput): Promise<NarrativeReport | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.info("[report-narrative] ANTHROPIC_API_KEY is not set — skipping.");
    return null;
  }

  try {
    const client = new Anthropic({ apiKey, timeout: NARRATIVE_TIMEOUT_MS });
    const response = await client.messages.create({
      model: NARRATIVE_MODEL,
      max_tokens: NARRATIVE_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      console.warn("[report-narrative] Response contained no text block — skipping.");
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonText(textBlock.text));
    } catch {
      console.warn("[report-narrative] Response was not valid JSON — skipping.");
      return null;
    }

    const result = NarrativeReportSchema.safeParse(parsed);
    if (!result.success) {
      console.warn("[report-narrative] Response failed schema validation — skipping.", result.error.message);
      return null;
    }

    return {
      ...result.data,
      topRisks: result.data.topRisks.slice(0, TOP_LIST_LIMIT),
      topOpportunities: result.data.topOpportunities.slice(0, TOP_LIST_LIMIT),
    };
  } catch (err) {
    console.warn("[report-narrative] Failed to generate — skipping.", err instanceof Error ? err.message : err);
    return null;
  }
}
