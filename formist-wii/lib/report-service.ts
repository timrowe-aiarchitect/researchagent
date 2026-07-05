import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  CATEGORY_LABELS,
  RISK_CATEGORIES,
  type BusinessRisk,
  type Grade,
  type Priority,
  type ReadinessLabel,
} from "@/lib/scoring";
import type { QualitativeAssessment } from "@/lib/qualitative-assessment";
import type {
  CategoryStatus,
  CrawlStatus,
  DetectedCms,
  EvidenceCategory,
  Severity,
} from "@/generated/prisma/enums";

const PDF_RENDER_TIMEOUT_MS = 30000;

/**
 * The Website Intelligence Index report generation service.
 *
 * buildReportData() is a pure function: scan metadata + category scores + evidence + recommendations
 * + screenshots + the already-computed overall score/grade/businessRisk/aiReadiness/priority in,
 * a single structured ReportData object out (the 11 sections below, in order). It performs no
 * scoring itself — all scores are computed by lib/scoring.ts and passed in — this module is only
 * responsible for organizing that data into report form and writing it in Formist's voice
 * (strategic, direct, evidence-based, human-centered, focused on business value, no hype).
 *
 * lib/report-html.ts renders ReportData to a self-contained HTML document; generateReportPdf()
 * below renders that HTML to a PDF file via Playwright.
 */

const KEY_FINDINGS_LIMIT = 8;
const BUSINESS_RISK_DRIVERS_LIMIT = 5;
const SEVERITY_RANK: Record<Severity, number> = { info: 0, minor: 1, moderate: 2, major: 3, critical: 4 };

// AI discoverability and WordPress maintainability get their own dedicated sections (7 and 8), so
// they're excluded from the generic category deep dives (6) to avoid showing the same category twice.
const DEDICATED_SECTION_CATEGORIES: EvidenceCategory[] = ["ai_discoverability", "wordpress_maintainability"];

export type ReportEvidenceInput = {
  id: string;
  category: EvidenceCategory;
  source: string;
  severity: Severity;
  finding: string;
  url: string | null;
  confidence: number;
};

export type ReportCategoryScoreInput = {
  category: EvidenceCategory;
  score: number;
  maxScore: number;
  status: CategoryStatus;
  rationale: string;
  confidence: number;
  evidenceRefs: string[];
};

export type ReportRecommendationInput = {
  priorityRank: number;
  title: string;
  category: EvidenceCategory;
  impact: string;
  effort: string;
  recommendation: string;
};

export type ReportScreenshotInput = {
  pageUrl: string;
  path: string;
};

export type ReportScanMetaInput = {
  rootUrl: string;
  clientName: string | null;
  detectedCms: DetectedCms;
  pagesRequested: number;
  pagesCrawled: number;
  generatedAt: Date;
  pages: { url: string; httpStatus: number | null; crawlStatus: CrawlStatus }[];
};

export type ReportInput = {
  scan: ReportScanMetaInput;
  categoryScores: ReportCategoryScoreInput[];
  evidenceItems: ReportEvidenceInput[];
  recommendations: ReportRecommendationInput[];
  screenshots: ReportScreenshotInput[];
  overallScore: number;
  grade: Grade;
  businessRisk: BusinessRisk;
  aiReadiness: { score: number; label: ReadinessLabel };
  priority: Priority;
  qualitativeAssessment: QualitativeAssessment | null;
};

export type ReportEvidenceItem = {
  source: string;
  severity: Severity;
  finding: string;
  url: string | null;
  confidence: number;
};

export type ReportCategorySummary = {
  category: EvidenceCategory;
  label: string;
  score: number;
  maxScore: number;
  status: CategoryStatus;
  rationale: string;
  confidence: number;
  evidence: ReportEvidenceItem[];
};

export type ReportData = {
  cover: {
    rootUrl: string;
    clientName: string | null;
    detectedCms: DetectedCms;
    generatedAt: string;
    pagesCrawled: number;
    pagesRequested: number;
    overallScore: number;
    grade: Grade;
  };
  executiveSummary: string;
  executiveScorecard: {
    overallScore: number;
    grade: Grade;
    businessRisk: BusinessRisk;
    businessRiskDrivers: string[];
    aiReadiness: { score: number; label: ReadinessLabel };
    priority: Priority;
    methodologyNote: string;
  };
  overallIndex: {
    overallScore: number;
    grade: Grade;
    categoryBreakdown: {
      category: EvidenceCategory;
      label: string;
      score: number;
      maxScore: number;
      status: CategoryStatus;
    }[];
  };
  keyFindings: {
    category: EvidenceCategory;
    categoryLabel: string;
    severity: Severity;
    finding: string;
    url: string | null;
  }[];
  categoryDeepDives: ReportCategorySummary[];
  aiDiscoverabilityAssessment: {
    score: number;
    maxScore: number;
    status: CategoryStatus;
    rationale: string;
    confidence: number;
    evidence: ReportEvidenceItem[];
    strategistPerspective: QualitativeAssessment["aiDiscoverability"] | null;
  };
  wordpressMaintainabilityAssessment:
    | {
        applicable: true;
        score: number;
        maxScore: number;
        status: CategoryStatus;
        rationale: string;
        confidence: number;
        evidence: ReportEvidenceItem[];
      }
    | { applicable: false; note: string };
  priorityRoadmap: {
    priorityRank: number;
    title: string;
    category: EvidenceCategory;
    categoryLabel: string;
    impact: string;
    effort: string;
    recommendation: string;
  }[];
  recommendedNextSteps: string[];
  appendixEvidence: {
    category: EvidenceCategory;
    categoryLabel: string;
    items: ReportEvidenceItem[];
  }[];
  screenshots: ReportScreenshotInput[];
};

function toEvidenceItem(e: ReportEvidenceInput): ReportEvidenceItem {
  return { source: e.source, severity: e.severity, finding: e.finding, url: e.url, confidence: e.confidence };
}

function buildCategorySummary(
  cs: ReportCategoryScoreInput,
  evidenceById: Map<string, ReportEvidenceInput>
): ReportCategorySummary {
  const evidence = cs.evidenceRefs
    .map((id) => evidenceById.get(id))
    .filter((e): e is ReportEvidenceInput => Boolean(e))
    .map(toEvidenceItem);
  return {
    category: cs.category,
    label: CATEGORY_LABELS[cs.category],
    score: cs.score,
    maxScore: cs.maxScore,
    status: cs.status,
    rationale: cs.rationale,
    confidence: cs.confidence,
    evidence,
  };
}

function buildExecutiveSummary(input: ReportInput): string {
  const { rootUrl } = input.scan;
  const riskSentence: Record<BusinessRisk, string> = {
    critical: "several critical issues require immediate attention",
    high: "a number of high-impact issues are holding the site back",
    medium: "some meaningful gaps are limiting the site's effectiveness",
    low: "the site is in solid working order with only minor gaps",
  };
  return (
    `${rootUrl} scores ${input.overallScore}/100 (Grade ${input.grade}) on the Website Intelligence Index. ` +
    `Overall, ${riskSentence[input.businessRisk]}. ` +
    `AI discoverability — how easily AI assistants and answer engines can find and represent this business — ` +
    `stands at ${input.aiReadiness.label.toLowerCase()}. ` +
    `The findings below are organized by category, with every score traced to specific evidence, ` +
    `and a priority roadmap sequencing the highest-value next steps.`
  );
}

function buildBusinessRiskDrivers(evidenceItems: ReportEvidenceInput[]): string[] {
  return evidenceItems
    .filter((e) => RISK_CATEGORIES.includes(e.category) && (e.severity === "major" || e.severity === "critical"))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, BUSINESS_RISK_DRIVERS_LIMIT)
    .map((e) => e.finding);
}

function buildKeyFindings(
  evidenceItems: ReportEvidenceInput[]
): ReportData["keyFindings"] {
  const bySeverityDesc = [...evidenceItems]
    .filter((e) => e.severity !== "info")
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  // One finding per category+source at most, so key findings don't repeat the same issue for
  // every page it was found on.
  const seen = new Set<string>();
  const deduped: ReportEvidenceInput[] = [];
  for (const e of bySeverityDesc) {
    const key = `${e.category}:${e.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
    if (deduped.length >= KEY_FINDINGS_LIMIT) break;
  }

  return deduped.map((e) => ({
    category: e.category,
    categoryLabel: CATEGORY_LABELS[e.category],
    severity: e.severity,
    finding: e.finding,
    url: e.url,
  }));
}

export function buildReportData(input: ReportInput): ReportData {
  const evidenceById = new Map(input.evidenceItems.map((e) => [e.id, e]));
  const isWordPress = input.categoryScores.some((cs) => cs.category === "wordpress_maintainability");

  const methodologyNote = isWordPress
    ? "Scored across all 10 WII categories, including WordPress maintainability."
    : "WordPress maintainability was not applicable for this site; its points were redistributed across the other 9 categories.";

  const categoryBreakdown = [...input.categoryScores]
    .sort((a, b) => b.score / b.maxScore - a.score / a.maxScore)
    .map((cs) => ({
      category: cs.category,
      label: CATEGORY_LABELS[cs.category],
      score: cs.score,
      maxScore: cs.maxScore,
      status: cs.status,
    }));

  const categoryDeepDives = input.categoryScores
    .filter((cs) => !DEDICATED_SECTION_CATEGORIES.includes(cs.category))
    .sort((a, b) => b.score / b.maxScore - a.score / a.maxScore)
    .map((cs) => buildCategorySummary(cs, evidenceById));

  const aiCategoryScore = input.categoryScores.find((cs) => cs.category === "ai_discoverability");
  const aiDiscoverabilityAssessment: ReportData["aiDiscoverabilityAssessment"] = aiCategoryScore
    ? {
        ...buildCategorySummary(aiCategoryScore, evidenceById),
        strategistPerspective: input.qualitativeAssessment?.aiDiscoverability ?? null,
      }
    : {
        score: 0,
        maxScore: 0,
        status: "critical",
        rationale: "No AI discoverability evidence was collected for this scan.",
        confidence: 0,
        evidence: [],
        strategistPerspective: null,
      };

  const wpCategoryScore = input.categoryScores.find((cs) => cs.category === "wordpress_maintainability");
  const wordpressMaintainabilityAssessment: ReportData["wordpressMaintainabilityAssessment"] = wpCategoryScore
    ? { applicable: true, ...buildCategorySummary(wpCategoryScore, evidenceById) }
    : {
        applicable: false,
        note: "This site was not detected as running WordPress, so WordPress maintainability doesn't apply. Its points were redistributed across the other 9 categories rather than scored as a gap.",
      };

  const priorityRoadmap = [...input.recommendations]
    .sort((a, b) => a.priorityRank - b.priorityRank)
    .map((r) => ({
      priorityRank: r.priorityRank,
      title: r.title,
      category: r.category,
      categoryLabel: CATEGORY_LABELS[r.category],
      impact: r.impact,
      effort: r.effort,
      recommendation: r.recommendation,
    }));

  const recommendedNextSteps = [...new Set(input.recommendations.map((r) => r.recommendation))].slice(0, 6);

  const evidenceByCategory = new Map<EvidenceCategory, ReportEvidenceInput[]>();
  for (const e of input.evidenceItems) {
    const list = evidenceByCategory.get(e.category) ?? [];
    list.push(e);
    evidenceByCategory.set(e.category, list);
  }
  const appendixEvidence = [...evidenceByCategory.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, items]) => ({
      category,
      categoryLabel: CATEGORY_LABELS[category],
      items: items.map(toEvidenceItem),
    }));

  return {
    cover: {
      rootUrl: input.scan.rootUrl,
      clientName: input.scan.clientName,
      detectedCms: input.scan.detectedCms,
      generatedAt: input.scan.generatedAt.toISOString(),
      pagesCrawled: input.scan.pagesCrawled,
      pagesRequested: input.scan.pagesRequested,
      overallScore: input.overallScore,
      grade: input.grade,
    },
    executiveSummary: buildExecutiveSummary(input),
    executiveScorecard: {
      overallScore: input.overallScore,
      grade: input.grade,
      businessRisk: input.businessRisk,
      businessRiskDrivers: buildBusinessRiskDrivers(input.evidenceItems),
      aiReadiness: input.aiReadiness,
      priority: input.priority,
      methodologyNote,
    },
    overallIndex: { overallScore: input.overallScore, grade: input.grade, categoryBreakdown },
    keyFindings: buildKeyFindings(input.evidenceItems),
    categoryDeepDives,
    aiDiscoverabilityAssessment,
    wordpressMaintainabilityAssessment,
    priorityRoadmap,
    recommendedNextSteps,
    appendixEvidence,
    screenshots: input.screenshots,
  };
}

/**
 * Renders the report HTML to a client-ready PDF via a headless Playwright browser and saves it
 * under public/reports/<scanId>.pdf. Never throws: a browser-launch failure, a render timeout, or
 * any other error degrades to `null` (so Report.pdfUrl stays null) rather than failing the scan —
 * the JSON and HTML report are still produced either way.
 */
export async function generateReportPdf(html: string, scanId: string): Promise<string | null> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle", timeout: PDF_RENDER_TIMEOUT_MS });

    const dir = path.join(process.cwd(), "public", "reports");
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${scanId}.pdf`;
    await page.pdf({
      path: path.join(dir, filename),
      format: "A4",
      printBackground: true,
      margin: { top: "24px", bottom: "24px", left: "24px", right: "24px" },
    });

    return `/reports/${filename}`;
  } catch (err) {
    console.warn(
      "[report-service] PDF generation failed — pdfUrl will be null.",
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    if (browser) await browser.close();
  }
}
