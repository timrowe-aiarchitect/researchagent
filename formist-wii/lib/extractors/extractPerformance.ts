import type { CrawledPageData } from "@/lib/crawler-service";
import type { LabMetrics, PageSpeedResult, PsiStrategy } from "@/lib/pagespeed-service";
import type { EvidenceExtractor, NormalizedEvidence } from "./types";
import { isCrawlOk } from "./types";

/**
 * Performance: three heuristic checks derivable from the crawl itself (load time, script count,
 * compression), plus — for the homepage and up to PSI_MAX_PRIORITY_PAGES priority pages — a real
 * Google PageSpeed Insights run (mobile + desktop) covering Lighthouse category scores, the
 * official field (CrUX) Core Web Vitals, and lab diagnostic timing metrics. PSI fetches happen
 * once per scan in scan-pipeline.ts (lib/pagespeed-service.ts) and are threaded in via
 * scan.pageSpeedResults — this file only reads and normalizes that pre-fetched data.
 *
 * Severity for PSI-derived metrics uses Google's published Good/Needs-Improvement/Poor bands
 * (per the PRD's scoring approach), not an arbitrary scale.
 */
export const extractPerformance: EvidenceExtractor = (scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];

  items.push(checkPageLoadTime(page));
  items.push(checkScriptWeight(page));
  items.push(checkResponseCompression(page));

  const psi = scan.pageSpeedResults[page.requestedUrl];
  if (psi) {
    items.push(...buildPsiEvidence(page, "mobile", psi.mobile));
    items.push(...buildPsiEvidence(page, "desktop", psi.desktop));
  }

  return items;
};

function checkPageLoadTime(page: CrawledPageData): NormalizedEvidence {
  const loadTimeMs = page.loadTimeMs;
  const severity =
    loadTimeMs < 1500 ? "info" : loadTimeMs < 3000 ? "minor" : loadTimeMs < 6000 ? "moderate" : "major";
  return {
    url: page.requestedUrl,
    category: "performance",
    source: "page_load_time",
    severity,
    finding: `Page took ${loadTimeMs}ms to load (navigation to network-idle).`,
    rawData: { loadTimeMs },
    confidence: 1,
    recommendationText:
      severity === "info"
        ? null
        : "Investigate slow server response times, render-blocking resources, or unoptimized assets.",
  };
}

function checkScriptWeight(page: CrawledPageData): NormalizedEvidence {
  const externalScriptCount = page.scripts.filter((s) => !s.inline).length;
  const severity = externalScriptCount > 15 ? "moderate" : externalScriptCount > 8 ? "minor" : "info";
  return {
    url: page.requestedUrl,
    category: "performance",
    source: "script_weight",
    severity,
    finding: `Page loads ${externalScriptCount} external script(s).`,
    rawData: { externalScriptCount, totalScriptCount: page.scripts.length },
    confidence: 0.7,
    recommendationText:
      severity === "info"
        ? null
        : "Reduce the number of separately-loaded scripts, or defer/async non-critical ones.",
  };
}

function checkResponseCompression(page: CrawledPageData): NormalizedEvidence {
  const contentEncoding = page.headers["content-encoding"];
  const isCompressed = Boolean(contentEncoding && /gzip|br|deflate/i.test(contentEncoding));
  return {
    url: page.requestedUrl,
    category: "performance",
    source: "response_compression",
    severity: isCompressed ? "info" : "minor",
    finding: isCompressed
      ? `Response is compressed (${contentEncoding}).`
      : "Response does not appear to be compressed.",
    rawData: { contentEncoding: contentEncoding ?? null },
    confidence: 1,
    recommendationText: isCompressed
      ? null
      : "Enable gzip or brotli compression on the server to reduce transfer size.",
  };
}

function buildPsiEvidence(
  page: CrawledPageData,
  strategy: PsiStrategy,
  result: PageSpeedResult
): NormalizedEvidence[] {
  if (!result.fetched) {
    return [
      {
        url: page.requestedUrl,
        category: "performance",
        source: `pagespeed_analysis_${strategy}`,
        severity: "info",
        finding: `not detected — PageSpeed Insights ${strategy} analysis could not be completed (${result.error ?? "unknown error"}). This is often the API's daily quota limit being reached.`,
        rawData: { fetched: false, error: result.error },
        confidence: 0.2,
        recommendationText: null,
      },
    ];
  }

  return [
    checkLighthouseScores(page, strategy, result),
    checkCoreWebVitals(page, strategy, result),
    checkLabPerformanceMetrics(page, strategy, result.lab, result.raw),
  ];
}

function scoreSeverity(score: number | null): NormalizedEvidence["severity"] {
  if (score === null) return "info";
  if (score >= 90) return "info";
  if (score >= 50) return "moderate";
  return "major";
}

function checkLighthouseScores(
  page: CrawledPageData,
  strategy: PsiStrategy,
  result: PageSpeedResult
): NormalizedEvidence {
  const { performance, accessibility, seo, bestPractices } = result.scores;
  const severity = scoreSeverity(performance);
  const parts = [
    `performance ${performance ?? "n/a"}`,
    `accessibility ${accessibility ?? "n/a"}`,
    `SEO ${seo ?? "n/a"}`,
    `best practices ${bestPractices ?? "n/a"}`,
  ];

  return {
    url: page.requestedUrl,
    category: "performance",
    source: `lighthouse_scores_${strategy}`,
    severity,
    finding: `Lighthouse (${strategy}) scores out of 100 — ${parts.join(", ")}.`,
    rawData: { scores: result.scores, psiRaw: result.raw },
    confidence: performance !== null ? 1 : 0.3,
    recommendationText:
      severity === "info"
        ? null
        : `Improve ${strategy} Lighthouse performance (currently ${performance ?? "unmeasured"}/100) — see the linked PSI report's opportunities and diagnostics for specifics.`,
  };
}

const CWV_THRESHOLDS = {
  lcpMs: { good: 2500, needsImprovement: 4000 },
  clsScore: { good: 0.1, needsImprovement: 0.25 },
  inpMs: { good: 200, needsImprovement: 500 },
} as const;

function bandSeverity(value: number, good: number, needsImprovement: number): NormalizedEvidence["severity"] {
  if (value <= good) return "info";
  if (value <= needsImprovement) return "moderate";
  return "major";
}

function worstSeverity(severities: NormalizedEvidence["severity"][]): NormalizedEvidence["severity"] {
  const rank: Record<NormalizedEvidence["severity"], number> = {
    info: 0,
    minor: 1,
    moderate: 2,
    major: 3,
    critical: 4,
  };
  return severities.reduce((worst, s) => (rank[s] > rank[worst] ? s : worst), "info" as NormalizedEvidence["severity"]);
}

function checkCoreWebVitals(
  page: CrawledPageData,
  strategy: PsiStrategy,
  result: PageSpeedResult
): NormalizedEvidence {
  const { field, lab } = result;

  if (!field) {
    // No field (CrUX) data exists for this page/origin — usually low real-world traffic.
    // Fall back to lab LCP/CLS as an estimate; INP has no lab equivalent, so it stays unmeasured.
    const lcpSeverity =
      lab.lcpMs !== null ? bandSeverity(lab.lcpMs, CWV_THRESHOLDS.lcpMs.good, CWV_THRESHOLDS.lcpMs.needsImprovement) : "info";
    const clsSeverity =
      lab.clsScore !== null
        ? bandSeverity(lab.clsScore, CWV_THRESHOLDS.clsScore.good, CWV_THRESHOLDS.clsScore.needsImprovement)
        : "info";
    return {
      url: page.requestedUrl,
      category: "performance",
      source: `core_web_vitals_${strategy}`,
      severity: worstSeverity([lcpSeverity, clsSeverity]),
      finding:
        `not detected — no real-user (CrUX) field data exists for Core Web Vitals on this page/origin (${strategy}). ` +
        `Using lab estimates instead: LCP ${lab.lcpMs ?? "n/a"}ms, CLS ${lab.clsScore ?? "n/a"}. INP has no lab equivalent and could not be estimated.`,
      rawData: { fieldDataAvailable: false, labEstimate: { lcpMs: lab.lcpMs, clsScore: lab.clsScore } },
      confidence: 0.4,
      recommendationText: null,
    };
  }

  const lcpSeverity =
    field.lcpMs !== null
      ? bandSeverity(field.lcpMs, CWV_THRESHOLDS.lcpMs.good, CWV_THRESHOLDS.lcpMs.needsImprovement)
      : "info";
  const clsSeverity =
    field.clsScore !== null
      ? bandSeverity(field.clsScore, CWV_THRESHOLDS.clsScore.good, CWV_THRESHOLDS.clsScore.needsImprovement)
      : "info";
  const inpSeverity =
    field.inpMs !== null
      ? bandSeverity(field.inpMs, CWV_THRESHOLDS.inpMs.good, CWV_THRESHOLDS.inpMs.needsImprovement)
      : "info";
  const severity = worstSeverity([lcpSeverity, clsSeverity, inpSeverity]);

  return {
    url: page.requestedUrl,
    category: "performance",
    source: `core_web_vitals_${strategy}`,
    severity,
    finding:
      `Real-user Core Web Vitals (${strategy}, ${field.source}-level CrUX data): ` +
      `LCP ${field.lcpMs ?? "n/a"}ms, CLS ${field.clsScore ?? "n/a"}, INP ${field.inpMs ?? "n/a (no field data)"}ms.`,
    rawData: { fieldDataAvailable: true, field },
    confidence: 1,
    recommendationText:
      severity === "info"
        ? null
        : "Improve the Core Web Vital(s) outside the 'Good' threshold — see rawData for which of LCP/CLS/INP is driving this.",
  };
}

const LAB_THRESHOLDS = {
  fcpMs: { good: 1800, needsImprovement: 3000 },
  ttfbMs: { good: 800, needsImprovement: 1800 },
  speedIndexMs: { good: 3400, needsImprovement: 5800 },
  totalBlockingTimeMs: { good: 200, needsImprovement: 600 },
} as const;

function checkLabPerformanceMetrics(
  page: CrawledPageData,
  strategy: PsiStrategy,
  lab: LabMetrics,
  psiRaw: Record<string, unknown> | null
): NormalizedEvidence {
  const severities: NormalizedEvidence["severity"][] = [];
  if (lab.fcpMs !== null) severities.push(bandSeverity(lab.fcpMs, LAB_THRESHOLDS.fcpMs.good, LAB_THRESHOLDS.fcpMs.needsImprovement));
  if (lab.ttfbMs !== null) severities.push(bandSeverity(lab.ttfbMs, LAB_THRESHOLDS.ttfbMs.good, LAB_THRESHOLDS.ttfbMs.needsImprovement));
  if (lab.speedIndexMs !== null)
    severities.push(bandSeverity(lab.speedIndexMs, LAB_THRESHOLDS.speedIndexMs.good, LAB_THRESHOLDS.speedIndexMs.needsImprovement));
  if (lab.totalBlockingTimeMs !== null)
    severities.push(
      bandSeverity(
        lab.totalBlockingTimeMs,
        LAB_THRESHOLDS.totalBlockingTimeMs.good,
        LAB_THRESHOLDS.totalBlockingTimeMs.needsImprovement
      )
    );

  const anyMeasured = severities.length > 0;
  const severity = anyMeasured ? worstSeverity(severities) : "info";

  return {
    url: page.requestedUrl,
    category: "performance",
    source: `lab_performance_metrics_${strategy}`,
    severity,
    finding: anyMeasured
      ? `Lab diagnostics (${strategy}): FCP ${lab.fcpMs ?? "n/a"}ms, TTFB ${lab.ttfbMs ?? "n/a"}ms, Speed Index ${lab.speedIndexMs ?? "n/a"}ms, Total Blocking Time ${lab.totalBlockingTimeMs ?? "n/a"}ms.`
      : `not detected — no lab diagnostic timing metrics were returned by PageSpeed Insights (${strategy}).`,
    rawData: { lab, psiRaw },
    confidence: anyMeasured ? 1 : 0.3,
    recommendationText:
      severity === "info" || !anyMeasured
        ? null
        : "Reduce server response time, main-thread blocking JavaScript, and render-blocking resources to improve these lab timing metrics.",
  };
}
