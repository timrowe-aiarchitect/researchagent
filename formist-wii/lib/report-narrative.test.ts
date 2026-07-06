import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateReportNarrative, type ReportNarrativeInput } from "@/lib/report-narrative";

const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

const VALID_NARRATIVE = {
  executiveSummary: "Example Co scores well overall, with one clear technical gap to close.",
  topRisks: ["No sitemap.xml was found, which limits search engine discovery."],
  topOpportunities: ["Homepage messaging is clear and can anchor future content."],
  categorySummaries: [{ category: "technical_seo", summary: "A missing sitemap is the main technical gap." }],
  priorityRoadmapNarrative: "Start with the sitemap — it's low effort with an outsized discovery payoff.",
  recommendedNextSteps: ["Publish a sitemap.xml and submit it to Search Console."],
};

const SAMPLE_INPUT: ReportNarrativeInput = {
  scan: {
    rootUrl: "https://example.com",
    clientName: "Example Co",
    industry: "Manufacturing",
    conversionGoal: "Request a quote",
  },
  overallScore: 62,
  grade: "C",
  businessRisk: "medium",
  aiReadiness: { score: 55, label: "Medium" },
  priority: "medium",
  categoryScores: [
    {
      category: "technical_seo",
      score: 6,
      maxScore: 12,
      status: "needs_attention",
      rationale: "Half of technical SEO checks passed.",
      confidence: 0.8,
      evidenceRefs: ["ev-1"],
    },
  ],
  evidenceItems: [
    {
      id: "ev-1",
      category: "technical_seo",
      source: "sitemap_missing",
      severity: "major",
      finding: "No sitemap.xml was found.",
      url: "https://example.com/",
      confidence: 1,
    },
  ],
  recommendations: [
    {
      priorityRank: 1,
      title: "sitemap missing",
      category: "technical_seo",
      impact: "High",
      effort: "Low",
      recommendation: "Add a sitemap.xml and submit it to Search Console.",
    },
  ],
};

function anthropicApiResponse(text: string, status = 200) {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
});

describe("generateReportNarrative", () => {
  it("returns null without ever calling the API when no ANTHROPIC_API_KEY is set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateReportNarrative(SAMPLE_INPUT);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses a well-formed JSON response into the expected shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse(JSON.stringify(VALID_NARRATIVE))));

    const result = await generateReportNarrative(SAMPLE_INPUT);

    expect(result).toEqual(VALID_NARRATIVE);
  });

  it("strips markdown code fences before parsing, in case the model adds them despite instructions", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_NARRATIVE) + "\n```";
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse(fenced)));

    const result = await generateReportNarrative(SAMPLE_INPUT);

    expect(result).toEqual(VALID_NARRATIVE);
  });

  it("caps topRisks/topOpportunities at 5 even if the model returned more", async () => {
    const tooMany = {
      ...VALID_NARRATIVE,
      topRisks: ["r1", "r2", "r3", "r4", "r5", "r6", "r7"],
      topOpportunities: ["o1", "o2", "o3", "o4", "o5", "o6"],
    };
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse(JSON.stringify(tooMany))));

    const result = await generateReportNarrative(SAMPLE_INPUT);

    expect(result?.topRisks).toHaveLength(5);
    expect(result?.topOpportunities).toHaveLength(5);
  });

  it("returns null when the response isn't valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse("not json at all")));

    const result = await generateReportNarrative(SAMPLE_INPUT);

    expect(result).toBeNull();
  });

  it("returns null when the response is valid JSON but fails schema validation", async () => {
    const incomplete = { executiveSummary: "Missing everything else." };
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse(JSON.stringify(incomplete))));

    const result = await generateReportNarrative(SAMPLE_INPUT);

    expect(result).toBeNull();
  });

  it("returns null when a categorySummaries entry has an unrecognized category", async () => {
    const badCategory = {
      ...VALID_NARRATIVE,
      categorySummaries: [{ category: "not_a_real_category", summary: "..." }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse(JSON.stringify(badCategory))));

    const result = await generateReportNarrative(SAMPLE_INPUT);

    expect(result).toBeNull();
  });

  it("returns null (never throws) on a network/API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    const result = await generateReportNarrative(SAMPLE_INPUT);

    expect(result).toBeNull();
  });

  it("returns null (never throws) on a non-2xx API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        anthropicApiResponse(JSON.stringify({ type: "error", error: { message: "overloaded" } }), 529)
      )
    );

    const result = await generateReportNarrative(SAMPLE_INPUT);

    expect(result).toBeNull();
  });
});
