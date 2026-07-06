import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildReportData,
  generateReportPdf,
  type ReportCategoryScoreInput,
  type ReportEvidenceInput,
  type ReportInput,
} from "@/lib/report-service";
import { buildReportHtml } from "@/lib/report-html";
import type { QualitativeAssessment } from "@/lib/qualitative-assessment";
import type { NarrativeReport } from "@/lib/report-narrative";

function evidence(overrides: Partial<ReportEvidenceInput> = {}): ReportEvidenceInput {
  return {
    id: overrides.id ?? "ev-1",
    category: "technical_seo",
    source: "sitemap_missing",
    severity: "major",
    finding: "No sitemap.xml was found.",
    url: "https://example.com/",
    confidence: 1,
    ...overrides,
  };
}

function categoryScore(overrides: Partial<ReportCategoryScoreInput> = {}): ReportCategoryScoreInput {
  return {
    category: "technical_seo",
    score: 6,
    maxScore: 12,
    status: "needs_attention",
    rationale: "Half of technical SEO checks passed.",
    confidence: 0.8,
    evidenceRefs: ["ev-1"],
    ...overrides,
  };
}

const qualitativeAssessment: QualitativeAssessment = {
  brandExperience: {
    score: 7,
    maxScore: 10,
    rationale: "Clear value proposition on the homepage.",
    evidence: ["Homepage headline states the core offer."],
    recommendations: ["Add customer testimonials to the homepage."],
    confidence: "Medium",
  },
  uxConversion: {
    score: 6,
    maxScore: 10,
    rationale: "Primary CTA is present but not repeated on interior pages.",
    evidence: ["Above-the-fold CTA found on homepage only."],
    recommendations: ["Repeat the primary CTA on interior pages."],
    confidence: "Medium",
  },
  aiDiscoverability: {
    score: 8,
    maxScore: 13,
    rationale: "Structured data is present but incomplete.",
    evidence: ["Organization schema found; missing FAQ schema."],
    recommendations: ["Add FAQ schema to key service pages."],
    confidence: "High",
  },
};

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    scan: {
      rootUrl: "https://example.com",
      clientName: "Example Co",
      detectedCms: "other",
      pagesRequested: 10,
      pagesCrawled: 8,
      generatedAt: new Date("2026-01-01T00:00:00Z"),
      pages: [{ url: "https://example.com", httpStatus: 200, crawlStatus: "success" }],
    },
    categoryScores: [categoryScore()],
    evidenceItems: [evidence()],
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
    screenshots: [],
    overallScore: 62,
    grade: "C",
    businessRisk: "medium",
    aiReadiness: { score: 55, label: "Medium" },
    priority: "medium",
    qualitativeAssessment,
    narrative: null,
    reviewStatus: "draft",
    ...overrides,
  };
}

const narrative: NarrativeReport = {
  executiveSummary: "Example Co's site is solid but has room to grow in technical foundations.",
  topRisks: ["Missing sitemap makes discovery harder for search engines."],
  topOpportunities: ["Strong homepage messaging is a foundation to build on."],
  categorySummaries: [{ category: "technical_seo", summary: "Technical SEO needs a sitemap fix." }],
  priorityRoadmapNarrative: "Start with the sitemap fix — it's low effort and unblocks discovery.",
  recommendedNextSteps: ["Publish a sitemap.xml and submit it to Search Console this week."],
};

describe("buildReportData", () => {
  it("assembles all 11 report sections from the raw inputs", () => {
    const data = buildReportData(baseInput());

    expect(data.cover.rootUrl).toBe("https://example.com");
    // Final overallScore is re-derived from the effective category scores (here, just the single
    // technical_seo category at 6/12) — automatedOverallScore is the untouched scan-time snapshot.
    expect(data.cover.overallScore).toBe(6);
    expect(data.cover.automatedOverallScore).toBe(62);
    expect(data.executiveSummary).toContain("https://example.com");
    expect(data.executiveScorecard.businessRisk).toBe("medium");
    expect(data.overallIndex.categoryBreakdown).toHaveLength(1);
    expect(data.keyFindings).toHaveLength(1);
    expect(data.keyFindings[0].finding).toBe("No sitemap.xml was found.");
    expect(data.categoryDeepDives).toHaveLength(1);
    expect(data.priorityRoadmap).toHaveLength(1);
    expect(data.recommendedNextSteps).toEqual(["Add a sitemap.xml and submit it to Search Console."]);
    expect(data.appendixEvidence).toHaveLength(1);
    expect(data.appendixEvidence[0].items).toHaveLength(1);
  });

  it("excludes AI discoverability and WordPress maintainability from the generic category deep dives", () => {
    const data = buildReportData(
      baseInput({
        categoryScores: [
          categoryScore(),
          categoryScore({ category: "ai_discoverability", maxScore: 13, evidenceRefs: [] }),
          categoryScore({ category: "wordpress_maintainability", maxScore: 8, evidenceRefs: [] }),
        ],
      })
    );

    expect(data.categoryDeepDives.map((cs) => cs.category)).toEqual(["technical_seo"]);
    expect(data.aiDiscoverabilityAssessment.maxScore).toBe(13);
    expect(data.wordpressMaintainabilityAssessment.applicable).toBe(true);
  });

  it("attaches the qualitative strategist perspective to the AI discoverability section", () => {
    const data = buildReportData(
      baseInput({
        categoryScores: [categoryScore({ category: "ai_discoverability", maxScore: 13, evidenceRefs: [] })],
      })
    );

    expect(data.aiDiscoverabilityAssessment.strategistPerspective).toEqual(qualitativeAssessment.aiDiscoverability);
  });

  it("marks WordPress maintainability not applicable when no WordPress category score is present", () => {
    const data = buildReportData(baseInput());

    expect(data.wordpressMaintainabilityAssessment.applicable).toBe(false);
    if (!data.wordpressMaintainabilityAssessment.applicable) {
      expect(data.wordpressMaintainabilityAssessment.note).toContain("not detected as running WordPress");
    }
    expect(data.executiveScorecard.methodologyNote).toContain("not applicable");
  });

  it("marks WordPress maintainability applicable and scored when a WordPress category score is present", () => {
    const data = buildReportData(
      baseInput({
        categoryScores: [
          categoryScore(),
          categoryScore({
            category: "wordpress_maintainability",
            maxScore: 8,
            score: 4,
            evidenceRefs: ["ev-1"],
          }),
        ],
      })
    );

    expect(data.wordpressMaintainabilityAssessment).toMatchObject({ applicable: true, score: 4, maxScore: 8 });
    expect(data.executiveScorecard.methodologyNote).toContain("including WordPress maintainability");
  });

  it("surfaces only major/critical risk-category findings as business risk drivers", () => {
    const data = buildReportData(
      baseInput({
        evidenceItems: [
          evidence({ id: "ev-1", category: "security", severity: "critical", finding: "No HTTPS redirect." }),
          evidence({ id: "ev-2", category: "technical_seo", severity: "minor", finding: "Missing alt text." }),
          evidence({ id: "ev-3", category: "brand_experience", severity: "critical", finding: "Vague homepage copy." }),
        ],
        categoryScores: [categoryScore({ evidenceRefs: ["ev-1", "ev-2", "ev-3"] })],
      })
    );

    expect(data.executiveScorecard.businessRiskDrivers).toEqual(["No HTTPS redirect."]);
  });

  it("passes screenshots through unchanged", () => {
    const data = buildReportData(
      baseInput({ screenshots: [{ pageUrl: "https://example.com", path: "screenshots/scan-1/home.png" }] })
    );

    expect(data.screenshots).toEqual([{ pageUrl: "https://example.com", path: "screenshots/scan-1/home.png" }]);
  });

  it("falls back to deterministic template prose when no narrative was generated", () => {
    const data = buildReportData(baseInput({ narrative: null }));

    expect(data.executiveSummary).toContain("https://example.com");
    expect(data.topRisks).toEqual(["No sitemap.xml was found."]);
    expect(data.topOpportunities[0]).toContain("Technical SEO is a relative strength to build on");
    expect(data.priorityRoadmapNarrative).toBe("Ranked by business impact vs. estimated effort.");
    expect(data.recommendedNextSteps).toEqual(["Add a sitemap.xml and submit it to Search Console."]);
    expect(data.categoryDeepDives[0].rationale).toBe("Half of technical SEO checks passed.");
  });

  it("uses the LLM-generated narrative prose when present, without touching any score, status, or evidence ref", () => {
    const data = buildReportData(baseInput({ narrative }));

    expect(data.executiveSummary).toBe(narrative.executiveSummary);
    expect(data.topRisks).toEqual(narrative.topRisks);
    expect(data.topOpportunities).toEqual(narrative.topOpportunities);
    expect(data.priorityRoadmapNarrative).toBe(narrative.priorityRoadmapNarrative);
    expect(data.recommendedNextSteps).toEqual(narrative.recommendedNextSteps);
    expect(data.categoryDeepDives[0].rationale).toBe("Technical SEO needs a sitemap fix.");

    // The narrative only replaces displayed prose — the underlying score, status, and evidence
    // references are exactly what the deterministic scoring engine computed.
    expect(data.categoryDeepDives[0].score).toBe(6);
    expect(data.categoryDeepDives[0].maxScore).toBe(12);
    expect(data.categoryDeepDives[0].status).toBe("needs_attention");
    expect(data.categoryDeepDives[0].evidence).toEqual(data.appendixEvidence[0].items);
  });

  it("falls back to the deterministic rationale for a category the narrative didn't cover", () => {
    const data = buildReportData(
      baseInput({
        categoryScores: [
          categoryScore(),
          categoryScore({
            category: "performance",
            maxScore: 12,
            evidenceRefs: [],
            rationale: "Largest Contentful Paint is slow on mobile.",
          }),
        ],
        narrative,
      })
    );

    const performance = data.categoryDeepDives.find((cs) => cs.category === "performance")!;
    expect(performance.rationale).toBe("Largest Contentful Paint is slow on mobile.");
  });

  it("caps narrative topRisks/topOpportunities at 5 even if the LLM returned more", () => {
    const data = buildReportData(
      baseInput({
        narrative: {
          ...narrative,
          topRisks: ["r1", "r2", "r3", "r4", "r5", "r6"],
          topOpportunities: ["o1", "o2", "o3", "o4", "o5", "o6"],
        },
      })
    );

    expect(data.topRisks).toHaveLength(5);
    expect(data.topOpportunities).toHaveLength(5);
  });
});

describe("generateReportPdf", () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");

  it("renders a real PDF file to disk for valid report HTML", async () => {
    const scanId = `test-scan-${Date.now()}`;
    const html = buildReportHtml(buildReportData(baseInput()));

    const pdfUrl = await generateReportPdf(html, scanId);

    expect(pdfUrl).toBe(`/reports/${scanId}.pdf`);
    const filePath = path.join(reportsDir, `${scanId}.pdf`);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).size).toBeGreaterThan(0);

    fs.rmSync(filePath, { force: true });
  }, 30000);

  it("degrades to null instead of throwing when the browser fails to launch", async () => {
    const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "/nonexistent/chromium-binary";

    try {
      const pdfUrl = await generateReportPdf("<html><body>test</body></html>", "test-scan-failure");
      expect(pdfUrl).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    }
  }, 30000);
});
