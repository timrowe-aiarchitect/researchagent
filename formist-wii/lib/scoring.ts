import type { CategoryStatus, CrawlStatus, EvidenceCategory, Severity } from "@/generated/prisma/enums";

/**
 * The Website Intelligence Index scoring engine.
 *
 * This module is pure and synchronous by design: every function here takes plain data in and
 * returns plain data out, with no I/O, randomness, or LLM calls of any kind. That's a deliberate
 * structural guarantee of the rule "do not let LLM narrative change deterministic scores" —
 * scores are computed here, first, from evidence; any executive-summary or recommendation prose
 * generated elsewhere (e.g. lib/scan-pipeline.ts's buildExecutiveSummary) is built FROM these
 * numbers afterward and must never feed back into them.
 */

export type Grade = "A" | "B" | "C" | "D" | "F";
export type BusinessRisk = "low" | "medium" | "high" | "critical";
export type Priority = "low" | "medium" | "high" | "critical";
export type ReadinessLabel = "Low" | "Medium" | "High";

// A finding is "passed" when its severity is info — see lib/scan-pipeline.ts evidence builders.
export function isPassing(severity: Severity): boolean {
  return severity === "info";
}

/**
 * Category point allocation for the overall 0-100 WII score. These are absolute points, not
 * percentages — a category's stored score is already "out of maxPoints", and the overall score
 * is simply the sum of every category's score (see computeOverallScore). Sums to exactly 100.
 */
export const CATEGORY_MAX_POINTS: Record<EvidenceCategory, number> = {
  technical_seo: 12,
  on_page_seo: 10,
  ai_discoverability: 13,
  performance: 12,
  accessibility: 8,
  security: 10,
  analytics: 7,
  wordpress_maintainability: 8,
  brand_experience: 10,
  conversion: 10,
};

export const CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  technical_seo: "Technical SEO",
  on_page_seo: "On-Page SEO",
  ai_discoverability: "AI Discoverability",
  performance: "Performance",
  accessibility: "Accessibility",
  security: "Security & Compliance",
  analytics: "Analytics & Measurement",
  wordpress_maintainability: "WordPress Maintainability",
  brand_experience: "Brand Experience",
  conversion: "UX & Conversion",
};

/**
 * Redistributes wordpress_maintainability's points across the other 9 categories, proportional
 * to their existing share, when a site isn't WordPress — so the max always sums to 100 and
 * overall scores stay comparable across CMS types (mirrors the old percentage-weight
 * redistribution, just expressed in points now).
 */
export function getEffectiveMaxPoints(includeWordpress: boolean): Record<EvidenceCategory, number> {
  if (includeWordpress) return { ...CATEGORY_MAX_POINTS };

  const wpPoints = CATEGORY_MAX_POINTS.wordpress_maintainability;
  const others = Object.entries(CATEGORY_MAX_POINTS).filter(
    ([category]) => category !== "wordpress_maintainability"
  ) as [EvidenceCategory, number][];
  const otherTotal = others.reduce((sum, [, points]) => sum + points, 0);

  const redistributed = Object.fromEntries(
    others.map(([category, points]) => [category, points + wpPoints * (points / otherTotal)])
  ) as Record<EvidenceCategory, number>;

  redistributed.wordpress_maintainability = 0;
  return redistributed;
}

/**
 * Relative severity penalty weights (not points) — deliberately steep so a single critical
 * finding can't be diluted by many trivial passes, satisfying "penalize critical issues more
 * heavily." Combined with SEVERITY_CEILING below for the actual per-category score.
 */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 0,
  minor: 1,
  moderate: 3,
  major: 7,
  critical: 15,
};

/**
 * Hard ceiling on a category's score ratio (0-1) based on the single worst severity present.
 * This is what actually guarantees "one critical exposure can't be diluted by many trivial
 * passes" — a weighted average alone can still be pulled back up by enough passing checks; a
 * ceiling can't be.
 */
const SEVERITY_CEILING: Record<Severity, number> = {
  info: 1,
  minor: 0.9,
  moderate: 0.75,
  major: 0.55,
  critical: 0.3,
};

function worstSeverity(evidence: { severity: Severity }[]): Severity {
  return evidence.reduce<Severity>(
    (worst, e) => (SEVERITY_WEIGHT[e.severity] > SEVERITY_WEIGHT[worst] ? e.severity : worst),
    "info"
  );
}

/**
 * A category's score ratio (0-1), evidence-based: a confidence-weighted average deduction across
 * every check, further capped by the ceiling for the single worst severity present. Categories
 * with no evidence return a neutral 0.5 (missing data isn't scored as failing, per the PRD) —
 * callers should treat that combined with low confidence, not as a real result.
 */
export function computeCategoryRatio(evidence: { severity: Severity; confidence: number }[]): number {
  if (evidence.length === 0) return 0.5;

  const totalWeight = evidence.reduce(
    (sum, e) => sum + SEVERITY_WEIGHT[e.severity] * clamp01(e.confidence),
    0
  );
  const maxPossibleWeight = evidence.length * SEVERITY_WEIGHT.critical;
  const weightedRatio = maxPossibleWeight > 0 ? 1 - totalWeight / maxPossibleWeight : 1;

  const ceiling = SEVERITY_CEILING[worstSeverity(evidence)];
  return Math.max(0, Math.min(weightedRatio, ceiling));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Category status band — same 90/70/50 bands as the old percentage scale, applied to the ratio. */
export function statusFromRatio(ratio: number): CategoryStatus {
  if (ratio >= 0.9) return "good";
  if (ratio >= 0.7) return "needs_attention";
  if (ratio >= 0.5) return "poor";
  return "critical";
}

/**
 * Confidence for a category: the confidence-weighted evidence average, lightly discounted when
 * the scan crawled fewer pages than requested (per the PRD: "flag reduced confidence when a
 * category has significant missing data"). No evidence at all yields low, fixed confidence.
 */
export function computeCategoryConfidence(
  evidence: { confidence: number }[],
  pagesCrawled: number,
  pagesRequested: number
): number {
  if (evidence.length === 0) return 0.3;

  const avgConfidence = evidence.reduce((sum, e) => sum + clamp01(e.confidence), 0) / evidence.length;
  const coverageRatio = pagesRequested > 0 ? Math.min(1, pagesCrawled / pagesRequested) : 1;
  const confidence = avgConfidence * (0.85 + 0.15 * coverageRatio);
  return Math.round(clamp01(confidence) * 100) / 100;
}

function buildRationale(evidence: { severity: Severity }[]): string {
  if (evidence.length === 0) {
    return "No evidence was collected for this category during this scan.";
  }

  const bySeverity: Record<Severity, number> = { info: 0, minor: 0, moderate: 0, major: 0, critical: 0 };
  for (const e of evidence) bySeverity[e.severity]++;
  const passed = bySeverity.info;
  const failing = evidence.length - passed;

  if (failing === 0) {
    return `All ${evidence.length} check(s) passed.`;
  }

  const parts = (["critical", "major", "moderate", "minor"] as Severity[])
    .filter((s) => bySeverity[s] > 0)
    .map((s) => `${bySeverity[s]} ${s}`);
  return `${passed} of ${evidence.length} check(s) passed; ${parts.join(", ")} finding(s) affected this category's score.`;
}

export function gradeFromScore(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function readinessLabel(score0to100: number): ReadinessLabel {
  if (score0to100 >= 80) return "High";
  if (score0to100 >= 50) return "Medium";
  return "Low";
}

/** Kept for callers that only have percentage-scale scores (e.g. AI readiness) and want the same banding language as risk/priority use internally. */
export const riskOrReadinessLabel = readinessLabel;

// Categories whose findings can drive elevated business risk — see PRD §8.4.
const RISK_CATEGORIES: EvidenceCategory[] = [
  "security",
  "technical_seo",
  "accessibility",
  "wordpress_maintainability",
];

/**
 * Derived (not averaged) from the presence of high-severity findings in risk-relevant categories,
 * per PRD §8.4. Operates on category ratios (0-1), not raw points, so the thresholds are stable
 * regardless of a category's point allocation.
 */
export function deriveBusinessRisk(
  evidence: { category: EvidenceCategory; severity: Severity }[],
  categoryRatios: Partial<Record<EvidenceCategory, number>>
): BusinessRisk {
  const riskFindings = evidence.filter(
    (e) => !isPassing(e.severity) && RISK_CATEGORIES.includes(e.category)
  );

  const hasCritical = riskFindings.some(
    (e) => e.severity === "critical" && (e.category === "security" || e.category === "wordpress_maintainability")
  );
  if (hasCritical) return "critical";

  const majorCount = riskFindings.filter((e) => e.severity === "major").length;
  const hasLowRatioCategory = RISK_CATEGORIES.some((c) => (categoryRatios[c] ?? 1) < 0.5);
  if (majorCount >= 2 || hasLowRatioCategory) return "high";

  const hasMediumRatioCategory = RISK_CATEGORIES.some((c) => {
    const r = categoryRatios[c] ?? 1;
    return r >= 0.5 && r < 0.75;
  });
  if (majorCount >= 1 || hasMediumRatioCategory) return "medium";

  return "low";
}

/**
 * Primarily the AI discoverability category, adjusted by Technical SEO and On-page SEO (content
 * extractability/crawlability) per PRD §8.5. Operates on ratios, returns both a 0-100 score and
 * a Low/Medium/High label using the same bands as the overall grade.
 */
export function deriveAiReadiness(categoryRatios: Partial<Record<EvidenceCategory, number>>): {
  score: number;
  label: ReadinessLabel;
} {
  const ai = categoryRatios.ai_discoverability ?? 0;
  const technicalSeo = categoryRatios.technical_seo ?? 0;
  const onPageSeo = categoryRatios.on_page_seo ?? 0;
  const blendedRatio = ai * 0.7 + technicalSeo * 0.15 + onPageSeo * 0.15;
  const score = Math.round(blendedRatio * 1000) / 10;
  return { score, label: readinessLabel(score) };
}

/**
 * Sums already-computed, already-persisted category scores into the overall 0-100 score. Safe to
 * call with just { score } (e.g. read back from the CategoryScore table) because redistribution
 * happens once, at write time, in computeScanScore — every stored category score is already
 * "out of its effective maxScore," so no per-category weighting is needed again here.
 */
export function computeOverallScore(categoryScores: { score: number }[]): number {
  return Math.round(categoryScores.reduce((sum, cs) => sum + cs.score, 0) * 10) / 10;
}

/** Synthesizes overallScore + businessRisk into a single "how urgently should this be acted on" label. */
export function derivePriority(overallScore: number, businessRisk: BusinessRisk): Priority {
  if (businessRisk === "critical") return "critical";
  if (businessRisk === "high" || overallScore < 60) return "high";
  if (businessRisk === "medium" || overallScore < 80) return "medium";
  return "low";
}

// --- Top-level orchestrator ---

export type ScoringEvidenceInput = {
  id: string;
  category: EvidenceCategory;
  severity: Severity;
  confidence: number;
};

export type ScoringPageInput = {
  crawlStatus: CrawlStatus;
};

export type ScoringScanMeta = {
  pagesRequested: number;
  isWordPress: boolean;
};

export type CategoryScoreResult = {
  category: EvidenceCategory;
  label: string;
  score: number;
  maxScore: number;
  status: CategoryStatus;
  rationale: string;
  confidence: number;
  evidenceRefs: string[];
};

export type ScoringResult = {
  categoryScores: CategoryScoreResult[];
  overallScore: number;
  grade: Grade;
  businessRisk: BusinessRisk;
  aiReadiness: { score: number; label: ReadinessLabel };
  priority: Priority;
};

/**
 * The single entry point: evidence + pages + scan metadata in, every scored output out. Category
 * scores are evidence-based only (computeCategoryRatio) — nothing here reads or is influenced by
 * any generated narrative text.
 */
export function computeScanScore(input: {
  evidence: ScoringEvidenceInput[];
  pages: ScoringPageInput[];
  scanMeta: ScoringScanMeta;
}): ScoringResult {
  const { evidence, pages, scanMeta } = input;
  const effectiveMaxPoints = getEffectiveMaxPoints(scanMeta.isWordPress);
  const pagesCrawled = pages.filter(
    (p) => p.crawlStatus === "success" || p.crawlStatus === "redirect"
  ).length;

  const categoryRatios: Partial<Record<EvidenceCategory, number>> = {};
  const categoryScores: CategoryScoreResult[] = [];

  for (const [category, maxScore] of Object.entries(effectiveMaxPoints) as [EvidenceCategory, number][]) {
    if (maxScore <= 0) continue; // excluded (e.g. wordpress_maintainability on a non-WP site)

    const categoryEvidence = evidence.filter((e) => e.category === category);
    const ratio = computeCategoryRatio(categoryEvidence);
    categoryRatios[category] = ratio;

    categoryScores.push({
      category,
      label: CATEGORY_LABELS[category],
      score: Math.round(maxScore * ratio * 10) / 10,
      maxScore: Math.round(maxScore * 10) / 10,
      status: statusFromRatio(ratio),
      rationale: buildRationale(categoryEvidence),
      confidence: computeCategoryConfidence(categoryEvidence, pagesCrawled, scanMeta.pagesRequested),
      evidenceRefs: categoryEvidence.map((e) => e.id),
    });
  }

  const overallScore = Math.round(categoryScores.reduce((sum, cs) => sum + cs.score, 0) * 10) / 10;
  const grade = gradeFromScore(overallScore);
  const businessRisk = deriveBusinessRisk(evidence, categoryRatios);
  const aiReadiness = deriveAiReadiness(categoryRatios);
  const priority = derivePriority(overallScore, businessRisk);

  return { categoryScores, overallScore, grade, businessRisk, aiReadiness, priority };
}
