import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { updateCategoryReview, updateReportStatus } from "@/lib/report-review";
import { buildReportData, type ReportData } from "@/lib/report-service";
import { buildReportHtml } from "@/lib/report-html";
import type { Prisma } from "@/generated/prisma/client";
import type { ReportStatus } from "@/generated/prisma/enums";

const cleanupClientIds: string[] = [];

afterEach(async () => {
  while (cleanupClientIds.length > 0) {
    const id = cleanupClientIds.pop()!;
    await prisma.client.delete({ where: { id } }).catch(() => {});
  }
});

async function createReviewFixture(reportStatus: ReportStatus = "draft") {
  const client = await prisma.client.create({
    data: { rootUrl: `https://review-test-${Date.now()}-${Math.random()}.example/`, name: "Test Co" },
  });
  cleanupClientIds.push(client.id);

  const scan = await prisma.scan.create({
    data: { clientId: client.id, requestedBy: "test", status: "complete", pagesRequested: 5, pagesCrawled: 3 },
  });

  const evidence = await prisma.evidenceItem.create({
    data: {
      scanId: scan.id,
      category: "technical_seo",
      source: "sitemap_missing",
      severity: "major",
      finding: "No sitemap.xml was found.",
      confidence: 1,
    },
  });

  await prisma.categoryScore.create({
    data: {
      scanId: scan.id,
      category: "technical_seo",
      score: 6,
      maxScore: 12,
      status: "poor",
      rationale: "Half of technical SEO checks passed.",
      confidence: 0.8,
      evidenceRefs: [evidence.id],
    },
  });

  const data = buildReportData({
    scan: {
      rootUrl: client.rootUrl,
      clientName: client.name,
      detectedCms: "other",
      pagesRequested: 5,
      pagesCrawled: 3,
      generatedAt: new Date(),
      pages: [],
    },
    categoryScores: [
      {
        category: "technical_seo",
        score: 6,
        maxScore: 12,
        status: "poor",
        rationale: "Half of technical SEO checks passed.",
        confidence: 0.8,
        evidenceRefs: [evidence.id],
      },
    ],
    evidenceItems: [
      {
        id: evidence.id,
        category: "technical_seo",
        source: "sitemap_missing",
        severity: "major",
        finding: "No sitemap.xml was found.",
        url: null,
        confidence: 1,
      },
    ],
    recommendations: [],
    screenshots: [],
    overallScore: 6,
    grade: "F",
    businessRisk: "low",
    aiReadiness: { score: 0, label: "Low" },
    priority: "low",
    qualitativeAssessment: null,
    narrative: null,
    reviewStatus: reportStatus,
  });

  const report = await prisma.report.create({
    data: {
      scanId: scan.id,
      executiveSummary: data.executiveSummary,
      fullReport: data as unknown as Prisma.InputJsonValue,
      html: buildReportHtml(data),
      status: reportStatus,
    },
  });

  return { client, scan, report };
}

describe("updateCategoryReview", () => {
  it("requires a note whenever the submitted score differs from the automated score", async () => {
    const { report } = await createReviewFixture();

    const result = await updateCategoryReview({
      reportId: report.id,
      category: "technical_seo",
      rationale: "Half of technical SEO checks passed.",
      score: 9,
      note: null,
      reviewerName: "Jamie",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("note");
  });

  it("allows editing only the rationale without a note", async () => {
    const { report } = await createReviewFixture();

    const result = await updateCategoryReview({
      reportId: report.id,
      category: "technical_seo",
      rationale: "Rewritten for clarity: the sitemap is missing.",
      score: 6,
      note: null,
      reviewerName: "Jamie",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.rationale).toBe("Rewritten for clarity: the sitemap is missing.");
      expect(result.summary.score).toBe(6);
      expect(result.summary.isOverridden).toBe(true);
    }
  });

  it("overrides a score with a note, re-deriving status and the overall figures", async () => {
    const { report } = await createReviewFixture();

    const result = await updateCategoryReview({
      reportId: report.id,
      category: "technical_seo",
      rationale: "Half of technical SEO checks passed.",
      score: 11,
      note: "Manual review found the automated check was too harsh.",
      reviewerName: "Jamie",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.score).toBe(11);
      expect(result.summary.status).toBe("good");
      expect(result.summary.automatedScore).toBe(6);
      expect(result.summary.overriddenBy).toBe("Jamie");
    }

    const updatedReport = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    const data = updatedReport.fullReport as unknown as ReportData;
    expect(data.cover.overallScore).toBe(11);
    expect(data.cover.automatedOverallScore).toBe(6);
    expect(data.overallIndex.categoryBreakdown[0].isOverridden).toBe(true);
  });

  it("rejects a score outside the category's valid range", async () => {
    const { report } = await createReviewFixture();

    const result = await updateCategoryReview({
      reportId: report.id,
      category: "technical_seo",
      rationale: "Half of technical SEO checks passed.",
      score: 999,
      note: "Too high",
      reviewerName: "Jamie",
    });

    expect(result.ok).toBe(false);
  });

  it("clearing an override (resubmitting the automated score/rationale) reverts to automated", async () => {
    const { report } = await createReviewFixture();

    await updateCategoryReview({
      reportId: report.id,
      category: "technical_seo",
      rationale: "Half of technical SEO checks passed.",
      score: 11,
      note: "Bumping this up.",
      reviewerName: "Jamie",
    });

    const cleared = await updateCategoryReview({
      reportId: report.id,
      category: "technical_seo",
      rationale: "Half of technical SEO checks passed.",
      score: 6,
      note: null,
      reviewerName: "Jamie",
    });

    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.summary.isOverridden).toBe(false);
      expect(cleared.summary.score).toBe(6);
      expect(cleared.summary.overriddenBy).toBeNull();
    }
  });

  it("rejects edits once the report has been exported", async () => {
    const { report } = await createReviewFixture("exported");

    const result = await updateCategoryReview({
      reportId: report.id,
      category: "technical_seo",
      rationale: "Half of technical SEO checks passed.",
      score: 8,
      note: "Trying to edit a locked report.",
      reviewerName: "Jamie",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exported");
  });

  it("errors when the category has no score to review", async () => {
    const { report } = await createReviewFixture();

    const result = await updateCategoryReview({
      reportId: report.id,
      category: "performance",
      rationale: "N/A",
      score: 5,
      note: "no such category was scored",
      reviewerName: "Jamie",
    });

    expect(result.ok).toBe(false);
  });
});

describe("updateReportStatus", () => {
  it("allows draft -> needs_review", async () => {
    const { report } = await createReviewFixture("draft");
    const result = await updateReportStatus({ reportId: report.id, status: "needs_review", reviewerName: "Jamie" });
    expect(result.ok).toBe(true);

    const updated = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(updated.status).toBe("needs_review");
    expect(updated.reviewedBy).toBe("Jamie");
  });

  it("rejects an invalid transition (draft -> approved)", async () => {
    const { report } = await createReviewFixture("draft");
    const result = await updateReportStatus({ reportId: report.id, status: "approved", reviewerName: "Jamie" });
    expect(result.ok).toBe(false);
  });

  it("has no allowed transitions once exported", async () => {
    const { report } = await createReviewFixture("exported");
    const result = await updateReportStatus({ reportId: report.id, status: "needs_review", reviewerName: "Jamie" });
    expect(result.ok).toBe(false);
  });

  it("regenerates a real PDF file when a report is approved", async () => {
    const { report, scan } = await createReviewFixture("needs_review");

    const result = await updateReportStatus({ reportId: report.id, status: "approved", reviewerName: "Jamie" });
    expect(result.ok).toBe(true);

    const updated = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(updated.status).toBe("approved");
    expect(updated.pdfUrl).toBe(`/reports/${scan.id}.pdf`);

    const pdfPath = path.join(process.cwd(), "public", "reports", `${scan.id}.pdf`);
    expect(fs.existsSync(pdfPath)).toBe(true);
    fs.rmSync(pdfPath, { force: true });
  }, 30000);
});
