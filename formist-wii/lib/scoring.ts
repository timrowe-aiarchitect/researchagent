import type { CategoryStatus, EvidenceCategory, Severity } from "@/generated/prisma/enums";

export type Grade = "A" | "B" | "C" | "D" | "F";
export type BusinessRisk = "low" | "medium" | "high" | "critical";

// A finding is "passed" when its severity is info — see lib/scan-pipeline.ts evidence builders.
export function isPassing(severity: Severity): boolean {
  return severity === "info";
}

// Category weighting for the overall WII score — see docs/PRD-website-intelligence-index-mvp.md §8.1
export const CATEGORY_WEIGHTS: Record<EvidenceCategory, number> = {
  technical_seo: 0.15,
  on_page_seo: 0.12,
  ai_discoverability: 0.12,
  performance: 0.12,
  accessibility: 0.1,
  security: 0.12,
  analytics: 0.08,
  wordpress_maintainability: 0.08,
  brand_experience: 0.06,
  conversion: 0.05,
};

export const CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  technical_seo: "Technical SEO",
  on_page_seo: "On-page SEO",
  ai_discoverability: "AI Discoverability",
  performance: "Performance",
  accessibility: "Accessibility",
  security: "Security",
  analytics: "Analytics",
  wordpress_maintainability: "WordPress Maintainability",
  brand_experience: "Brand Experience",
  conversion: "Conversion",
};

// §8.2 — severity-weighted deductions so critical findings can't be diluted by minor passes.
export const SEVERITY_DEDUCTION: Record<Severity, number> = {
  info: 0,
  minor: 5,
  moderate: 12,
  major: 25,
  critical: 45,
};

/** Redistributes the WordPress maintainability weight across the other 9 categories when a site isn't WordPress. §8.1 */
export function getEffectiveWeights(includeWordpress: boolean): Record<EvidenceCategory, number> {
  if (includeWordpress) return CATEGORY_WEIGHTS;

  const wpWeight = CATEGORY_WEIGHTS.wordpress_maintainability;
  const others = Object.entries(CATEGORY_WEIGHTS).filter(
    ([category]) => category !== "wordpress_maintainability"
  ) as [EvidenceCategory, number][];
  const otherTotal = others.reduce((sum, [, w]) => sum + w, 0);

  const redistributed = Object.fromEntries(
    others.map(([category, weight]) => [
      category,
      weight + wpWeight * (weight / otherTotal),
    ])
  ) as Record<EvidenceCategory, number>;

  redistributed.wordpress_maintainability = 0;
  return redistributed;
}

export function computeCategoryScore(evidence: { severity: Severity }[]): number {
  if (evidence.length === 0) return 100;
  const deduction = evidence
    .filter((e) => !isPassing(e.severity))
    .reduce((sum, e) => sum + SEVERITY_DEDUCTION[e.severity], 0);
  return Math.max(0, Math.min(100, 100 - deduction));
}

// CategoryScore.status — a coarse read of the score for at-a-glance UI, independent of the overall letter grade.
export function statusFromScore(score: number): CategoryStatus {
  if (score >= 90) return "good";
  if (score >= 70) return "needs_attention";
  if (score >= 50) return "poor";
  return "critical";
}

export function computeOverallScore(
  categoryScores: { category: EvidenceCategory; score: number }[],
  includeWordpress: boolean
): number {
  const weights = getEffectiveWeights(includeWordpress);
  const total = categoryScores.reduce(
    (sum, { category, score }) => sum + score * (weights[category] ?? 0),
    0
  );
  return Math.round(total * 10) / 10;
}

// §8.3
export function gradeFromScore(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

// §8.4 — driven primarily by Security, Technical SEO, Accessibility, and WordPress maintainability.
export function deriveBusinessRisk(
  evidence: { category: EvidenceCategory; severity: Severity }[],
  categoryScores: Partial<Record<EvidenceCategory, number>>
): BusinessRisk {
  const riskCategories: EvidenceCategory[] = [
    "security",
    "technical_seo",
    "accessibility",
    "wordpress_maintainability",
  ];
  const riskFindings = evidence.filter(
    (e) => !isPassing(e.severity) && riskCategories.includes(e.category)
  );

  const hasCritical = riskFindings.some(
    (e) => e.severity === "critical" && (e.category === "security" || e.category === "wordpress_maintainability")
  );
  if (hasCritical) return "critical";

  const majorCount = riskFindings.filter((e) => e.severity === "major").length;
  const lowRiskCategoryScore = riskCategories.some(
    (c) => (categoryScores[c] ?? 100) < 50
  );
  if (majorCount >= 2 || lowRiskCategoryScore) return "high";

  const isMediumBand = riskCategories.some((c) => {
    const s = categoryScores[c] ?? 100;
    return s >= 50 && s < 75;
  });
  if (majorCount >= 1 || isMediumBand) return "medium";

  return "low";
}

// §8.5 — primarily the AI discoverability category score.
export function deriveAiReadiness(
  categoryScores: Partial<Record<EvidenceCategory, number>>
): number {
  const aiScore = categoryScores.ai_discoverability ?? 0;
  const technicalSeo = categoryScores.technical_seo ?? 0;
  const onPageSeo = categoryScores.on_page_seo ?? 0;
  const blended = aiScore * 0.7 + technicalSeo * 0.15 + onPageSeo * 0.15;
  return Math.round(blended * 10) / 10;
}

export function riskOrReadinessLabel(score: number): "Low" | "Medium" | "High" {
  if (score >= 80) return "High";
  if (score >= 50) return "Medium";
  return "Low";
}
