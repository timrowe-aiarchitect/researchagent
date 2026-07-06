import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  CATEGORY_LABELS,
  RISK_CATEGORIES,
  computeScanScoreFromCategoryScores,
  statusFromRatio,
  type BusinessRisk,
  type Grade,
  type Priority,
  type ReadinessLabel,
} from "@/lib/scoring";
import type { QualitativeAssessment } from "@/lib/qualitative-assessment";
import type { NarrativeReport } from "@/lib/report-narrative";
import type {
  CategoryStatus,
  CrawlStatus,
  DetectedCms,
  EvidenceCategory,
  ReportStatus,
  Severity,
} from "@/generated/prisma/enums";

const PDF_RENDER_TIMEOUT_MS = 30000;

/**
 * The Website Intelligence Index report generation service.
 *
 * buildReportData() is a pure function: scan metadata + category scores (each carrying both its
 * automated result and any human reviewer override, see lib/report-review.ts) + evidence +
 * recommendations + screenshots + the automated overall score/grade/businessRisk/aiReadiness/
 * priority in, a single structured ReportData object out (the 11 sections below, in order). It
 * re-derives the overall (final) score/grade/businessRisk/aiReadiness/priority from the effective
 * (override ?? automated) category scores via lib/scoring.ts's computeScanScoreFromCategoryScores
 * — the same deterministic formula computeScanScore uses, just re-applied to stored scores instead
 * of raw evidence — so this module still invents no scoring logic of its own; it only organizes
 * already-computed numbers into report form and writes prose in Formist's voice (strategic,
 * direct, evidence-based, human-centered, focused on business value, no hype).
 *
 * Every score-bearing field in ReportData exposes both its automated value (frozen at scan
 * completion, never mutated) and its effective/final value (automated, unless a reviewer overrode
 * it) — see PRD's human review workflow. Existing callers that only care about "the" score/status/
 * rationale keep reading the same field names as before; those now mean "final."
 *
 * lib/report-html.ts renders ReportData to a self-contained HTML document; generateReportPdf()
 * below renders that HTML to a PDF file via Playwright.
 */

const KEY_FINDINGS_LIMIT = 8;
const BUSINESS_RISK_DRIVERS_LIMIT = 5;
const TOP_LIST_LIMIT = 5;
const SEVERITY_RANK: Record<Severity, number> = { info: 0, minor: 1, moderate: 2, major: 3, critical: 4 };

// AI discoverability and WordPress maintainability get their own dedicated sections (7 and 8), so
// they're excluded from the generic category deep dives (6) to avoid showing the same category twice.
export const DEDICATED_SECTION_CATEGORIES: EvidenceCategory[] = ["ai_discoverability", "wordpress_maintainability"];

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
  // Automated fields — the scoring engine's original result, frozen at scan completion.
  score: number;
  maxScore: number;
  status: CategoryStatus;
  rationale: string;
  confidence: number;
  evidenceRefs: string[];
  // Human reviewer override (lib/report-review.ts) — all null/undefined until a reviewer acts.
  overrideScore?: number | null;
  overrideRationale?: string | null;
  overrideNote?: string | null;
  overriddenBy?: string | null;
  overriddenAt?: Date | null;
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
  narrative: NarrativeReport | null;
  reviewStatus: ReportStatus;
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
  maxScore: number;
  confidence: number;
  evidence: ReportEvidenceItem[];
  // Final/effective — automated, unless a reviewer overrode this category.
  score: number;
  status: CategoryStatus;
  rationale: string;
  // Automated — the scoring engine's original result, frozen at scan completion.
  automatedScore: number;
  automatedStatus: CategoryStatus;
  automatedRationale: string;
  // Review metadata
  isOverridden: boolean;
  overrideNote: string | null;
  overriddenBy: string | null;
  overriddenAt: string | null;
};

export type ReportData = {
  reviewStatus: ReportStatus;
  cover: {
    rootUrl: string;
    clientName: string | null;
    detectedCms: DetectedCms;
    generatedAt: string;
    pagesCrawled: number;
    pagesRequested: number;
    // Final/effective — automated, unless a reviewer overrode one or more category scores.
    overallScore: number;
    grade: Grade;
    // Automated — the scoring engine's original result, frozen at scan completion.
    automatedOverallScore: number;
    automatedGrade: Grade;
  };
  executiveSummary: string;
  topRisks: string[];
  topOpportunities: string[];
  executiveScorecard: {
    overallScore: number;
    grade: Grade;
    automatedOverallScore: number;
    automatedGrade: Grade;
    businessRisk: BusinessRisk;
    businessRiskDrivers: string[];
    aiReadiness: { score: number; label: ReadinessLabel };
    priority: Priority;
    methodologyNote: string;
  };
  overallIndex: {
    overallScore: number;
    grade: Grade;
    automatedOverallScore: number;
    automatedGrade: Grade;
    categoryBreakdown: {
      category: EvidenceCategory;
      label: string;
      score: number;
      maxScore: number;
      status: CategoryStatus;
      automatedScore: number;
      automatedStatus: CategoryStatus;
      isOverridden: boolean;
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
  aiDiscoverabilityAssessment: Omit<ReportCategorySummary, "category" | "label"> & {
    strategistPerspective: QualitativeAssessment["aiDiscoverability"] | null;
  };
  wordpressMaintainabilityAssessment:
    | (Omit<ReportCategorySummary, "category" | "label"> & { applicable: true })
    | { applicable: false; note: string };
  priorityRoadmapNarrative: string;
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

/**
 * The effective (override ?? automated) score and status for a category. When there's no
 * override, this returns the automated score/status exactly as stored — it never second-guesses
 * the scoring engine by re-deriving status from score/maxScore, since that reconstruction can
 * differ from the original unrounded ratio the engine actually used (see computeScanScore).
 * Status is only re-derived (via statusFromRatio) when a reviewer has overridden the score.
 */
export function effectiveCategoryValues(cs: ReportCategoryScoreInput): { score: number; status: CategoryStatus } {
  if (cs.overrideScore == null) {
    return { score: cs.score, status: cs.status };
  }
  const status = cs.maxScore > 0 ? statusFromRatio(cs.overrideScore / cs.maxScore) : cs.status;
  return { score: cs.overrideScore, status };
}

export function isCategoryOverridden(cs: ReportCategoryScoreInput): boolean {
  return cs.overrideScore != null || Boolean(cs.overrideRationale);
}

function buildCategorySummary(
  cs: ReportCategoryScoreInput,
  evidenceById: Map<string, ReportEvidenceInput>,
  narrativeSummaries: Map<EvidenceCategory, string>
): ReportCategorySummary {
  const evidence = cs.evidenceRefs
    .map((id) => evidenceById.get(id))
    .filter((e): e is ReportEvidenceInput => Boolean(e))
    .map(toEvidenceItem);
  const { score, status } = effectiveCategoryValues(cs);
  return {
    category: cs.category,
    label: CATEGORY_LABELS[cs.category],
    maxScore: cs.maxScore,
    confidence: cs.confidence,
    evidence,
    score,
    status,
    rationale: cs.overrideRationale ?? narrativeSummaries.get(cs.category) ?? cs.rationale,
    automatedScore: cs.score,
    automatedStatus: cs.status,
    automatedRationale: cs.rationale,
    isOverridden: isCategoryOverridden(cs),
    overrideNote: cs.overrideNote ?? null,
    overriddenBy: cs.overriddenBy ?? null,
    overriddenAt: cs.overriddenAt ? cs.overriddenAt.toISOString() : null,
  };
}

function buildExecutiveSummary(
  input: ReportInput,
  final: { overallScore: number; grade: Grade; businessRisk: BusinessRisk; aiReadiness: { label: ReadinessLabel } }
): string {
  const { rootUrl } = input.scan;
  const riskSentence: Record<BusinessRisk, string> = {
    critical: "several critical issues require immediate attention",
    high: "a number of high-impact issues are holding the site back",
    medium: "some meaningful gaps are limiting the site's effectiveness",
    low: "the site is in solid working order with only minor gaps",
  };
  return (
    `${rootUrl} scores ${final.overallScore}/100 (Grade ${final.grade}) on the Website Intelligence Index. ` +
    `Overall, ${riskSentence[final.businessRisk]}. ` +
    `AI discoverability — how easily AI assistants and answer engines can find and represent this business — ` +
    `stands at ${final.aiReadiness.label.toLowerCase()}. ` +
    `The findings below are organized by category, with every score traced to specific evidence, ` +
    `and a priority roadmap sequencing the highest-value next steps.`
  );
}

// Deterministic fallback for "top opportunities" when no narrative was generated: the
// highest-scoring categories, described via their own already-computed rationale text — grounded
// in evidence, never fabricated.
function buildFallbackTopOpportunities(categoryScores: ReportCategoryScoreInput[]): string[] {
  return [...categoryScores]
    .filter((cs) => cs.maxScore > 0)
    .sort((a, b) => effectiveCategoryValues(b).score / b.maxScore - effectiveCategoryValues(a).score / a.maxScore)
    .slice(0, BUSINESS_RISK_DRIVERS_LIMIT)
    .map((cs) => {
      const rationale = cs.overrideRationale ?? cs.rationale;
      return `${CATEGORY_LABELS[cs.category]} is a relative strength to build on: ${rationale}`;
    });
}

function buildFallbackRoadmapNarrative(roadmapLength: number): string {
  return roadmapLength > 0
    ? "Ranked by business impact vs. estimated effort."
    : "No high-priority issues were identified in this scan.";
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
  const narrativeSummaries = new Map(
    (input.narrative?.categorySummaries ?? []).map((cs) => [cs.category, cs.summary] as const)
  );
  const isWordPress = input.categoryScores.some((cs) => cs.category === "wordpress_maintainability");

  const methodologyNote = isWordPress
    ? "Scored across all 10 WII categories, including WordPress maintainability."
    : "WordPress maintainability was not applicable for this site; its points were redistributed across the other 9 categories.";

  // Final (effective) overall figures, re-derived from the effective per-category scores — the
  // same deterministic formula computeScanScore uses, just re-applied to stored scores. Identical
  // to the automated input.overallScore/etc. until a reviewer overrides a category.
  const final = computeScanScoreFromCategoryScores({
    categoryScores: input.categoryScores.map((cs) => ({
      category: cs.category,
      score: cs.overrideScore ?? cs.score,
      maxScore: cs.maxScore,
    })),
    evidence: input.evidenceItems.map((e) => ({ category: e.category, severity: e.severity })),
  });

  const categoryBreakdown = [...input.categoryScores]
    .sort((a, b) => effectiveCategoryValues(b).score / b.maxScore - effectiveCategoryValues(a).score / a.maxScore)
    .map((cs) => {
      const { score, status } = effectiveCategoryValues(cs);
      return {
        category: cs.category,
        label: CATEGORY_LABELS[cs.category],
        score,
        maxScore: cs.maxScore,
        status,
        automatedScore: cs.score,
        automatedStatus: cs.status,
        isOverridden: isCategoryOverridden(cs),
      };
    });

  const categoryDeepDives = input.categoryScores
    .filter((cs) => !DEDICATED_SECTION_CATEGORIES.includes(cs.category))
    .sort((a, b) => effectiveCategoryValues(b).score / b.maxScore - effectiveCategoryValues(a).score / a.maxScore)
    .map((cs) => buildCategorySummary(cs, evidenceById, narrativeSummaries));

  const aiCategoryScore = input.categoryScores.find((cs) => cs.category === "ai_discoverability");
  const aiDiscoverabilityAssessment: ReportData["aiDiscoverabilityAssessment"] = aiCategoryScore
    ? {
        ...buildCategorySummary(aiCategoryScore, evidenceById, narrativeSummaries),
        strategistPerspective: input.qualitativeAssessment?.aiDiscoverability ?? null,
      }
    : {
        score: 0,
        maxScore: 0,
        status: "critical",
        rationale: "No AI discoverability evidence was collected for this scan.",
        confidence: 0,
        evidence: [],
        automatedScore: 0,
        automatedStatus: "critical",
        automatedRationale: "No AI discoverability evidence was collected for this scan.",
        isOverridden: false,
        overrideNote: null,
        overriddenBy: null,
        overriddenAt: null,
        strategistPerspective: null,
      };

  const wpCategoryScore = input.categoryScores.find((cs) => cs.category === "wordpress_maintainability");
  const wordpressMaintainabilityAssessment: ReportData["wordpressMaintainabilityAssessment"] = wpCategoryScore
    ? { applicable: true, ...buildCategorySummary(wpCategoryScore, evidenceById, narrativeSummaries) }
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

  const recommendedNextSteps = input.narrative?.recommendedNextSteps.length
    ? input.narrative.recommendedNextSteps.slice(0, 6)
    : [...new Set(input.recommendations.map((r) => r.recommendation))].slice(0, 6);

  const keyFindings = buildKeyFindings(input.evidenceItems);

  const topRisks = input.narrative?.topRisks.length
    ? input.narrative.topRisks.slice(0, TOP_LIST_LIMIT)
    : keyFindings.slice(0, TOP_LIST_LIMIT).map((f) => f.finding);

  const topOpportunities = input.narrative?.topOpportunities.length
    ? input.narrative.topOpportunities.slice(0, TOP_LIST_LIMIT)
    : buildFallbackTopOpportunities(input.categoryScores);

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
    reviewStatus: input.reviewStatus,
    cover: {
      rootUrl: input.scan.rootUrl,
      clientName: input.scan.clientName,
      detectedCms: input.scan.detectedCms,
      generatedAt: input.scan.generatedAt.toISOString(),
      pagesCrawled: input.scan.pagesCrawled,
      pagesRequested: input.scan.pagesRequested,
      overallScore: final.overallScore,
      grade: final.grade,
      automatedOverallScore: input.overallScore,
      automatedGrade: input.grade,
    },
    executiveSummary: input.narrative?.executiveSummary ?? buildExecutiveSummary(input, final),
    topRisks,
    topOpportunities,
    executiveScorecard: {
      overallScore: final.overallScore,
      grade: final.grade,
      automatedOverallScore: input.overallScore,
      automatedGrade: input.grade,
      businessRisk: final.businessRisk,
      businessRiskDrivers: buildBusinessRiskDrivers(input.evidenceItems),
      aiReadiness: final.aiReadiness,
      priority: final.priority,
      methodologyNote,
    },
    overallIndex: {
      overallScore: final.overallScore,
      grade: final.grade,
      automatedOverallScore: input.overallScore,
      automatedGrade: input.grade,
      categoryBreakdown,
    },
    keyFindings,
    categoryDeepDives,
    aiDiscoverabilityAssessment,
    wordpressMaintainabilityAssessment,
    priorityRoadmapNarrative: input.narrative?.priorityRoadmapNarrative ?? buildFallbackRoadmapNarrative(priorityRoadmap.length),
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
