import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateQualitativeAssessment } from "@/lib/qualitative-assessment";

const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

const VALID_DIMENSION = {
  assessment: "Reasonably clear.",
  strengths: ["States a specific value proposition in the H1."],
  concerns: ["No supporting proof points were found."],
  confidence: 0.7,
};

const VALID_ASSESSMENT = {
  brandClarity: VALID_DIMENSION,
  ux: VALID_DIMENSION,
  conversionEffectiveness: VALID_DIMENSION,
  trust: VALID_DIMENSION,
  aiDiscoverability: VALID_DIMENSION,
  overallNarrative: "Overall, a reasonably clear but thin site.",
};

const SAMPLE_INPUT = {
  rootUrl: "https://example.com/",
  pages: [
    {
      url: "https://example.com/",
      title: "Example Co",
      metaDescription: "We do things.",
      h1: "Example Co",
      wordCount: 200,
    },
  ],
  evidence: [
    {
      category: "brand_experience" as const,
      source: "clarity_of_positioning",
      severity: "moderate" as const,
      finding: "Positioning clarity could not be confirmed.",
      confidence: 0.6,
      url: "https://example.com/",
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

describe("generateQualitativeAssessment", () => {
  it("returns null without ever calling the API when no ANTHROPIC_API_KEY is set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateQualitativeAssessment(SAMPLE_INPUT);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses a well-formed JSON response into the expected shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse(JSON.stringify(VALID_ASSESSMENT))));

    const result = await generateQualitativeAssessment(SAMPLE_INPUT);

    expect(result).toEqual(VALID_ASSESSMENT);
  });

  it("strips markdown code fences before parsing, in case the model adds them despite instructions", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_ASSESSMENT) + "\n```";
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse(fenced)));

    const result = await generateQualitativeAssessment(SAMPLE_INPUT);

    expect(result).toEqual(VALID_ASSESSMENT);
  });

  it("returns null when the response isn't valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse("not json at all")));

    const result = await generateQualitativeAssessment(SAMPLE_INPUT);

    expect(result).toBeNull();
  });

  it("returns null when the response is valid JSON but fails schema validation", async () => {
    const incomplete = { brandClarity: VALID_DIMENSION }; // missing every other required key
    vi.stubGlobal("fetch", vi.fn(async () => anthropicApiResponse(JSON.stringify(incomplete))));

    const result = await generateQualitativeAssessment(SAMPLE_INPUT);

    expect(result).toBeNull();
  });

  it("returns null (never throws) on a network/API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    const result = await generateQualitativeAssessment(SAMPLE_INPUT);

    expect(result).toBeNull();
  });

  it("returns null (never throws) on a non-2xx API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        anthropicApiResponse(JSON.stringify({ type: "error", error: { message: "overloaded" } }), 529)
      )
    );

    const result = await generateQualitativeAssessment(SAMPLE_INPUT);

    expect(result).toBeNull();
  });
});
