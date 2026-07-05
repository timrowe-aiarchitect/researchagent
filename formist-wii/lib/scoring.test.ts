import { describe, expect, it } from "vitest";
import {
  CATEGORY_MAX_POINTS,
  computeCategoryConfidence,
  computeCategoryRatio,
  computeOverallScore,
  computeScanScore,
  derivePriority,
  deriveAiReadiness,
  deriveBusinessRisk,
  getEffectiveMaxPoints,
  gradeFromScore,
  statusFromRatio,
} from "@/lib/scoring";
import type { EvidenceCategory, Severity } from "@/generated/prisma/enums";

function ev(severity: Severity, confidence = 1) {
  return { severity, confidence };
}

describe("CATEGORY_MAX_POINTS", () => {
  it("sums to exactly 100", () => {
    const total = Object.values(CATEGORY_MAX_POINTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });
});

describe("getEffectiveMaxPoints", () => {
  it("returns the raw table unchanged when WordPress is included", () => {
    expect(getEffectiveMaxPoints(true)).toEqual(CATEGORY_MAX_POINTS);
  });

  it("zeroes wordpress_maintainability and redistributes its points proportionally, still summing to 100", () => {
    const redistributed = getEffectiveMaxPoints(false);
    expect(redistributed.wordpress_maintainability).toBe(0);

    const total = Object.values(redistributed).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 5);

    // Technical SEO (12/92 share of the non-WP total) should have grown by its proportional cut
    // of the redistributed 8 points.
    const expectedTechnicalSeo = 12 + 8 * (12 / 92);
    expect(redistributed.technical_seo).toBeCloseTo(expectedTechnicalSeo, 5);
  });
});

describe("computeCategoryRatio", () => {
  it("returns 1 when every check passes", () => {
    expect(computeCategoryRatio([ev("info"), ev("info"), ev("info")])).toBe(1);
  });

  it("returns 0.5 with no evidence at all", () => {
    expect(computeCategoryRatio([])).toBe(0.5);
  });

  it("caps the ratio at 0.3 when any critical finding is present, regardless of how many checks pass", () => {
    const evidence = [ev("info"), ev("info"), ev("info"), ev("info"), ev("info"), ev("critical")];
    expect(computeCategoryRatio(evidence)).toBeLessThanOrEqual(0.3);
  });

  it("caps at 0.55 for a worst-case major (no critical)", () => {
    const evidence = [ev("info"), ev("info"), ev("info"), ev("major")];
    const ratio = computeCategoryRatio(evidence);
    expect(ratio).toBeLessThanOrEqual(0.55);
    expect(ratio).toBeGreaterThan(0.3);
  });

  it("caps at 0.75 for a worst-case moderate", () => {
    const evidence = [ev("info"), ev("info"), ev("moderate")];
    expect(computeCategoryRatio(evidence)).toBeLessThanOrEqual(0.75);
  });

  it("caps at 0.9 for a worst-case minor", () => {
    const evidence = [ev("info"), ev("info"), ev("minor")];
    expect(computeCategoryRatio(evidence)).toBeLessThanOrEqual(0.9);
  });

  it("a low-confidence lone critical finding is penalized less than a full-confidence one", () => {
    // With just one piece of evidence, the weighted-average term (not the ceiling) is what
    // binds, so confidence still matters even for a critical-severity finding.
    const lowConfidence = computeCategoryRatio([ev("critical", 0.2)]);
    const fullConfidence = computeCategoryRatio([ev("critical", 1)]);
    expect(lowConfidence).toBeGreaterThan(fullConfidence);
    expect(fullConfidence).toBe(0);
    expect(lowConfidence).toBeLessThanOrEqual(0.3);
  });

  it("never goes below 0", () => {
    const allCritical = Array.from({ length: 10 }, () => ev("critical"));
    expect(computeCategoryRatio(allCritical)).toBeGreaterThanOrEqual(0);
  });
});

describe("statusFromRatio", () => {
  it.each([
    [0.95, "good"],
    [0.9, "good"],
    [0.8, "needs_attention"],
    [0.7, "needs_attention"],
    [0.6, "poor"],
    [0.5, "poor"],
    [0.2, "critical"],
  ] as const)("ratio %s -> %s", (ratio, expected) => {
    expect(statusFromRatio(ratio)).toBe(expected);
  });
});

describe("computeCategoryConfidence", () => {
  it("returns a low fixed confidence when there is no evidence", () => {
    expect(computeCategoryConfidence([], 10, 10)).toBe(0.3);
  });

  it("returns ~ the average evidence confidence when crawl coverage is complete", () => {
    const confidence = computeCategoryConfidence([{ confidence: 1 }, { confidence: 1 }], 10, 10);
    expect(confidence).toBe(1);
  });

  it("discounts confidence when fewer pages were crawled than requested", () => {
    const fullCoverage = computeCategoryConfidence([{ confidence: 1 }], 10, 10);
    const halfCoverage = computeCategoryConfidence([{ confidence: 1 }], 5, 10);
    expect(halfCoverage).toBeLessThan(fullCoverage);
  });
});

describe("gradeFromScore", () => {
  it.each([
    [95, "A"],
    [90, "A"],
    [85, "B"],
    [80, "B"],
    [75, "C"],
    [70, "C"],
    [65, "D"],
    [60, "D"],
    [40, "F"],
  ] as const)("score %s -> grade %s", (score, expected) => {
    expect(gradeFromScore(score)).toBe(expected);
  });
});

describe("deriveBusinessRisk", () => {
  it("is critical when a critical finding exists in security", () => {
    const evidence = [{ category: "security" as EvidenceCategory, severity: "critical" as Severity }];
    expect(deriveBusinessRisk(evidence, { security: 0.3 })).toBe("critical");
  });

  it("is critical when a critical finding exists in wordpress_maintainability", () => {
    const evidence = [
      { category: "wordpress_maintainability" as EvidenceCategory, severity: "critical" as Severity },
    ];
    expect(deriveBusinessRisk(evidence, { wordpress_maintainability: 0.3 })).toBe("critical");
  });

  it("is NOT critical from a critical finding in a non-risk-elevating category (accessibility), but still high via its collapsed ratio", () => {
    const evidence = [
      { category: "accessibility" as EvidenceCategory, severity: "critical" as Severity },
    ];
    const risk = deriveBusinessRisk(evidence, { accessibility: 0.3 });
    expect(risk).not.toBe("critical");
    expect(risk).toBe("high");
  });

  it("is high with two or more major findings in risk categories", () => {
    const evidence = [
      { category: "security" as EvidenceCategory, severity: "major" as Severity },
      { category: "technical_seo" as EvidenceCategory, severity: "major" as Severity },
    ];
    expect(deriveBusinessRisk(evidence, { security: 0.8, technical_seo: 0.8 })).toBe("high");
  });

  it("is low when risk categories are clean", () => {
    expect(
      deriveBusinessRisk([], { security: 1, technical_seo: 1, accessibility: 1, wordpress_maintainability: 1 })
    ).toBe("low");
  });
});

describe("deriveAiReadiness", () => {
  it("blends ai_discoverability (70%), technical_seo (15%), and on_page_seo (15%)", () => {
    const { score, label } = deriveAiReadiness({
      ai_discoverability: 0.9,
      technical_seo: 0.8,
      on_page_seo: 0.8,
    });
    // 0.9*0.7 + 0.8*0.15 + 0.8*0.15 = 0.87 -> 87
    expect(score).toBeCloseTo(87, 1);
    expect(label).toBe("High");
  });

  it("defaults missing categories to 0", () => {
    const { score } = deriveAiReadiness({});
    expect(score).toBe(0);
  });
});

describe("derivePriority", () => {
  it("is critical when business risk is critical, regardless of score", () => {
    expect(derivePriority(95, "critical")).toBe("critical");
  });

  it("is high when business risk is high or score is low", () => {
    expect(derivePriority(90, "high")).toBe("high");
    expect(derivePriority(55, "low")).toBe("high");
  });

  it("is low for a clean, high-scoring scan", () => {
    expect(derivePriority(95, "low")).toBe("low");
  });
});

describe("computeOverallScore", () => {
  it("sums already-computed category scores", () => {
    expect(computeOverallScore([{ score: 10 }, { score: 8.5 }, { score: 12 }])).toBe(30.5);
  });
});

describe("computeScanScore (integration)", () => {
  const pages = [{ crawlStatus: "success" as const }, { crawlStatus: "success" as const }];

  it("scores a clean, all-passing WordPress scan at (close to) 100", () => {
    const evidence = (Object.keys(CATEGORY_MAX_POINTS) as EvidenceCategory[]).flatMap((category) => [
      { id: `${category}-1`, category, severity: "info" as Severity, confidence: 1 },
      { id: `${category}-2`, category, severity: "info" as Severity, confidence: 1 },
    ]);

    const result = computeScanScore({
      evidence,
      pages,
      scanMeta: { pagesRequested: 2, isWordPress: true },
    });

    expect(result.overallScore).toBe(100);
    expect(result.grade).toBe("A");
    expect(result.businessRisk).toBe("low");
    expect(result.priority).toBe("low");
    expect(result.categoryScores).toHaveLength(10);
    for (const cs of result.categoryScores) {
      expect(cs.score).toBe(cs.maxScore);
      expect(cs.evidenceRefs).toEqual([`${cs.category}-1`, `${cs.category}-2`]);
    }
  });

  it("excludes wordpress_maintainability and redistributes its points when isWordPress is false", () => {
    const evidence = (Object.keys(CATEGORY_MAX_POINTS) as EvidenceCategory[])
      .filter((c) => c !== "wordpress_maintainability")
      .map((category) => ({ id: `${category}-1`, category, severity: "info" as Severity, confidence: 1 }));

    const result = computeScanScore({
      evidence,
      pages,
      scanMeta: { pagesRequested: 2, isWordPress: false },
    });

    expect(result.categoryScores.find((cs) => cs.category === "wordpress_maintainability")).toBeUndefined();
    expect(result.categoryScores).toHaveLength(9);
    expect(result.overallScore).toBe(100);
  });

  it("a critical security finding drags overallScore down and elevates business risk/priority", () => {
    const evidence = (Object.keys(CATEGORY_MAX_POINTS) as EvidenceCategory[]).map((category) => ({
      id: `${category}-1`,
      category,
      severity: category === "security" ? ("critical" as Severity) : ("info" as Severity),
      confidence: 1,
    }));

    const result = computeScanScore({
      evidence,
      pages,
      scanMeta: { pagesRequested: 2, isWordPress: true },
    });

    expect(result.overallScore).toBeLessThan(100);
    expect(result.businessRisk).toBe("critical");
    expect(result.priority).toBe("critical");
    const securityScore = result.categoryScores.find((cs) => cs.category === "security")!;
    expect(securityScore.score).toBeLessThanOrEqual(securityScore.maxScore * 0.3);
  });

  it("gives a category with no evidence a neutral score and low confidence rather than penalizing it as failing", () => {
    const evidence = (Object.keys(CATEGORY_MAX_POINTS) as EvidenceCategory[])
      .filter((c) => c !== "analytics")
      .map((category) => ({ id: `${category}-1`, category, severity: "info" as Severity, confidence: 1 }));

    const result = computeScanScore({
      evidence,
      pages,
      scanMeta: { pagesRequested: 2, isWordPress: true },
    });

    const analytics = result.categoryScores.find((cs) => cs.category === "analytics")!;
    expect(analytics.score).toBeCloseTo(analytics.maxScore * 0.5, 5);
    expect(analytics.confidence).toBe(0.3);
    expect(analytics.evidenceRefs).toEqual([]);
  });
});
